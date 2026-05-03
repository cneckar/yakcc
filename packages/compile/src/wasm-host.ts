// SPDX-License-Identifier: MIT
//
// @decision DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001 (closed) — see WASM_HOST_CONTRACT.md.
// Status: decided (WI-V1W2-WASM-03)
// Rationale: Three sub-decisions are resolved here:
//
//   Sub-decision 1 — Trap shape:
//     WasmTrap base + 3 subclasses (WasmUnreachable, WasmDivByZero, WasmIntegerOverflow)
//     for engine-faulted traps caught as WebAssembly.RuntimeError; separate WasmPanic
//     for callee-initiated host_panic calls. TypeScript instanceof narrowing is more
//     ergonomic than discriminating on a kind field. The kind field is kept for JSON
//     serialization and log emission. Mapping is concentrated in wrapHostCall; no
//     ad-hoc catch elsewhere.
//
//   Sub-decision 2 — Allocator strategy:
//     Bump allocator. 1024-byte reserved scratch zone, 64 KB cap (one page). host_free
//     is a tracked no-op (_freeCallCount exposed for test introspection). Free-list
//     deferred to v2; host_free import is reserved so the contract does not change
//     when v2 switches.
//
//   Sub-decision 3 — Memory growth:
//     Forbidden in v1. Memory imported with initial=1, maximum=1. Growth attempts trap
//     as WasmTrap("memory_oob"). Lifting this is an explicit deferred surface in
//     WASM_HOST_CONTRACT.md §8.
//
// This file is the sole in-process host runtime authority. Downstream consumers and
// tests import from here. No second host runtime elsewhere.

/**
 * wasm-host.ts — In-process host runtime for @yakcc/compile WASM modules.
 *
 * Public surface:
 *   - WasmTrap (base), WasmUnreachable, WasmDivByZero, WasmIntegerOverflow — trap classes
 *   - WasmPanic — structured callee-initiated panic
 *   - WasmHost — interface for the host object
 *   - createWasmHost() — factory; each call returns an independent instance
 *   - importsFor(host) — builds WebAssembly.Imports keyed { host: { ... } }
 *   - wrapHostCall(fn) — catches WebAssembly.RuntimeError and rethrows as WasmTrap subclass
 *
 * See WASM_HOST_CONTRACT.md for the boundary contract (authority for this surface).
 */

// ---------------------------------------------------------------------------
// Trap classes — engine-faulted errors
// ---------------------------------------------------------------------------

/**
 * Base class for all WASM engine traps (WebAssembly.RuntimeError translated to host-side).
 *
 * A trap is an unintentional hardware-level fault surfaced by the WASM engine.
 * The `kind` field is a stable discriminator for logging and JSON serialization;
 * TypeScript callers should prefer instanceof for narrowing.
 *
 * @see WASM_HOST_CONTRACT.md §7
 */
export class WasmTrap extends Error {
  readonly kind: "unreachable" | "div_by_zero" | "integer_overflow" | "memory_oob" | "other";

  constructor(kind: WasmTrap["kind"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WasmTrap";
    this.kind = kind;
    // Maintain correct prototype chain in environments that transpile class extends
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * WASM `unreachable` opcode was executed.
 */
export class WasmUnreachable extends WasmTrap {
  constructor(message: string, options?: { cause?: unknown }) {
    super("unreachable", message, options);
    this.name = "WasmUnreachable";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Integer divide by zero (i32.div_s or i32.div_u with divisor = 0).
 */
export class WasmDivByZero extends WasmTrap {
  constructor(message: string, options?: { cause?: unknown }) {
    super("div_by_zero", message, options);
    this.name = "WasmDivByZero";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Integer overflow — e.g. INT32_MIN / -1 with i32.div_s.
 */
export class WasmIntegerOverflow extends WasmTrap {
  constructor(message: string, options?: { cause?: unknown }) {
    super("integer_overflow", message, options);
    this.name = "WasmIntegerOverflow";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// WasmPanic — callee-initiated structured error
// ---------------------------------------------------------------------------

/**
 * Structured error thrown when compiled WASM calls the `host_panic` import.
 *
 * Distinct from WasmTrap: a panic is a deliberate signal from the compiled program
 * (carrying code, ptr, len, and a UTF-8 decoded message). Traps are unintentional
 * engine-level faults.
 *
 * @see WASM_HOST_CONTRACT.md §7
 */
export class WasmPanic extends Error {
  readonly code: number;
  readonly ptr: number;
  readonly len: number;
  readonly decoded: string;

  constructor(args: { code: number; ptr: number; len: number; decoded: string }) {
    super(`WasmPanic(code=${args.code}): ${args.decoded}`);
    this.name = "WasmPanic";
    this.code = args.code;
    this.ptr = args.ptr;
    this.len = args.len;
    this.decoded = args.decoded;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// WasmHost interface
// ---------------------------------------------------------------------------

/**
 * The in-process host object provided to instantiated WASM modules.
 *
 * Each instance is independent: bump-allocator state, log buffer, and memory
 * are all per-instance. Never share a host across test cases.
 *
 * @see WASM_HOST_CONTRACT.md §3 (imports), §6 (allocator)
 */
export interface WasmHost {
  /** Linear memory exported to the WASM module. initial=1, maximum=1 (64 KB). */
  readonly memory: WebAssembly.Memory;

  /** Captured log lines (test/diagnostic surface). Each call to host_log appends one entry. */
  readonly logs: ReadonlyArray<string>;

  /**
   * Test-only counter for emitted host_free calls.
   * Not part of the public boundary contract; used to assert the emitter emits host_free.
   */
  readonly _freeCallCount: number;

  /** Diagnostic emission: decodes (ptr, len) as UTF-8 and appends to `logs`. */
  host_log(ptr: number, len: number): void;

  /**
   * Bump allocator: allocates `size` bytes (aligned to 8), returns pointer.
   * Throws WasmTrap("memory_oob") if the bump pointer would exceed 64 KB.
   */
  host_alloc(size: number): number;

  /**
   * Tracked no-op in v1. Increments _freeCallCount. Does not reclaim memory.
   * The bump allocator releases on host re-creation.
   */
  host_free(ptr: number): void;

  /**
   * Called by compiled WASM to signal an unrecoverable error.
   * Throws WasmPanic and never returns.
   */
  host_panic(code: number, ptr: number, len: number): never;

  /** Write UTF-8 bytes into linear memory, returning the pointer and length. */
  writeUtf8(bytes: Uint8Array): { ptr: number; len: number };

  /** Read UTF-8 bytes from linear memory at (ptr, len). */
  readUtf8(ptr: number, len: number): string;
}

// ---------------------------------------------------------------------------
// createWasmHost() — factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh WasmHost instance.
 *
 * Each call produces an independent host with:
 *   - a fresh WebAssembly.Memory(1, 1) (64 KB, no growth)
 *   - a bump pointer starting at offset 1024 (bytes [0,1024) are reserved scratch)
 *   - an empty log buffer
 *   - a free-call counter at 0
 *
 * @see WASM_HOST_CONTRACT.md §6
 */
export function createWasmHost(): WasmHost {
  // Memory: initial=1 page (64 KB), maximum=1 page (growth forbidden in v1).
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });

  // Bump allocator state.
  // Bytes [0, SCRATCH_BASE) are reserved scratch (currently unused).
  // Bytes [SCRATCH_BASE, MEM_CAP) are the bump heap.
  const SCRATCH_BASE = 1024;
  const MEM_CAP = 65536; // 64 KB = 1 WASM page
  let bumpOffset = SCRATCH_BASE;

  // Log buffer and free-call counter.
  const logBuffer: string[] = [];
  let freeCallCount = 0;

  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();

  const host: WasmHost = {
    get memory(): WebAssembly.Memory {
      return memory;
    },

    get logs(): ReadonlyArray<string> {
      return logBuffer;
    },

    get _freeCallCount(): number {
      return freeCallCount;
    },

    host_log(ptr: number, len: number): void {
      const view = new Uint8Array(memory.buffer, ptr, len);
      logBuffer.push(decoder.decode(view));
    },

    host_alloc(size: number): number {
      // Align to 8 bytes.
      const aligned = (size + 7) & ~7;
      if (bumpOffset + aligned > MEM_CAP) {
        throw new WasmTrap("memory_oob", "host_alloc out of memory");
      }
      const ptr = bumpOffset;
      bumpOffset += aligned;
      return ptr;
    },

    host_free(_ptr: number): void {
      // Tracked no-op. See DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001 sub-decision 2.
      freeCallCount++;
    },

    host_panic(code: number, ptr: number, len: number): never {
      const view = new Uint8Array(memory.buffer, ptr, len);
      const decoded = decoder.decode(view);
      throw new WasmPanic({ code, ptr, len, decoded });
    },

    writeUtf8(bytes: Uint8Array): { ptr: number; len: number } {
      const ptr = host.host_alloc(bytes.length);
      new Uint8Array(memory.buffer).set(bytes, ptr);
      return { ptr, len: bytes.length };
    },

    readUtf8(ptr: number, len: number): string {
      const view = new Uint8Array(memory.buffer, ptr, len);
      return decoder.decode(view);
    },
  };

  return host;
}

// ---------------------------------------------------------------------------
// importsFor() — build WebAssembly.Imports from a WasmHost
// ---------------------------------------------------------------------------

/**
 * Build a WebAssembly.Imports object from a WasmHost instance.
 *
 * Returns `{ host: { memory, host_log, host_alloc, host_free, host_panic } }`
 * matching the import namespace declared in the emitted module.
 *
 * @see WASM_HOST_CONTRACT.md §3
 */
export function importsFor(host: WasmHost): WebAssembly.Imports {
  return {
    host: {
      memory: host.memory,
      host_log: (ptr: number, len: number): void => host.host_log(ptr, len),
      host_alloc: (size: number): number => host.host_alloc(size),
      host_free: (ptr: number): void => host.host_free(ptr),
      host_panic: (code: number, ptr: number, len: number): void => {
        host.host_panic(code, ptr, len);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// wrapHostCall() — engine RuntimeError → WasmTrap subclass translator
// ---------------------------------------------------------------------------

/**
 * Wrap a thunk so that WebAssembly.RuntimeError instances are caught and
 * rethrown as the appropriate WasmTrap subclass.
 *
 * This is the **only** place engine runtime errors are translated. All callers
 * that invoke compiled WASM exports must funnel through this function.
 *
 * Mapping table (engine message pattern → rethrown class):
 *   /unreachable/i               → WasmUnreachable
 *   /divide by zero/i            → WasmDivByZero
 *   /integer overflow/i          → WasmIntegerOverflow
 *   /out of bounds memory access/i → WasmTrap("memory_oob")
 *   anything else                → WasmTrap("other")
 *
 * WasmTrap and WasmPanic instances are re-thrown unchanged (they are already
 * the correct type — host_panic throws WasmPanic before the engine sees anything).
 *
 * @see WASM_HOST_CONTRACT.md §7
 */
export function wrapHostCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    // Re-throw already-translated errors unchanged.
    if (err instanceof WasmPanic || err instanceof WasmTrap) throw err;

    if (err instanceof WebAssembly.RuntimeError) {
      const msg = err.message;
      if (/unreachable/i.test(msg)) {
        throw new WasmUnreachable("wasm 'unreachable' executed", { cause: err });
      }
      if (/divide by zero/i.test(msg)) {
        throw new WasmDivByZero("integer divide by zero", { cause: err });
      }
      // V8 emits "integer overflow" for some engines, but "divide result unrepresentable"
      // for INT32_MIN / -1 specifically. Both patterns map to WasmIntegerOverflow.
      if (/integer overflow/i.test(msg) || /divide result unrepresentable/i.test(msg)) {
        throw new WasmIntegerOverflow("integer overflow (e.g. INT32_MIN / -1)", { cause: err });
      }
      if (/out of bounds memory access/i.test(msg)) {
        throw new WasmTrap("memory_oob", msg, { cause: err });
      }
      throw new WasmTrap("other", msg, { cause: err });
    }

    throw err;
  }
}
