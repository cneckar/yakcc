/**
 * wasm-host.ts — In-process host runtime for yakcc-compiled WebAssembly modules.
 *
 * This module implements the host side of the WASM_HOST_CONTRACT.md v1 wave-2
 * specification. It provides:
 *   - createHost(): YakccHost   — construct a conformant import object + memory
 *   - instantiateAndRun(...)    — convenience wrapper: compile + run a single fn
 *   - WasmTrap                  — typed error for all trap conditions
 *   - WasmTrapKind              — discriminated union of the 7 trap classes
 *
 * The reference host uses a bump allocator (sub-decision 2) starting at offset 16,
 * with host_free as a no-op (the module may assume freed memory is not reclaimed).
 * Memory is fixed at 1 page / 64 KiB with no growth permitted (sub-decision 3).
 *
 * @decision DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001
 * @title WASM host interface — v1 wave-2 sub-decisions
 * @status accepted
 * @rationale
 *   Sub-decision 1 — Trap kind union:
 *     WasmTrap extends Error with discriminated readonly kind: the 7-kind union
 *     "unreachable"|"div_by_zero"|"int_overflow"|"oob_memory"|
 *     "indirect_call_mismatch"|"stack_overflow"|"oom" is symmetric with
 *     ResolutionError in resolve.ts (same typed-kind pattern), making pipeline
 *     error handling uniform. hostPanicCode preserves the raw numeric code for
 *     debugging without polluting the primary discriminant.
 *
 *   Sub-decision 2 — Bump allocator + host_free no-op:
 *     Bump allocator starting at offset 16 is the simplest correct allocator for
 *     a fixed single-page heap. O(1) alloc, 1 integer of state. host_free is a
 *     no-op with the explicit contract that the module MAY assume freed memory is
 *     not reclaimed. This makes future upgrades to a real free-list transparent
 *     at call sites (they already call host_free; the semantic upgrade is safe).
 *
 *   Sub-decision 3 — No memory growth in v1:
 *     Fixed {initial:1, maximum:1}. memory.grow would return -1 (engine enforces
 *     maximum). OOM surfaces as WasmTrap{kind:"oom"} via host_panic(0x01,...).
 *     Wave-3 removes this restriction under a new DEC.
 *
 * Conformance: passes all 8 tests in wasm-host.test.ts per WASM_HOST_CONTRACT.md §9.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the 7 trap classes reachable from v1 substrates.
 *
 * Symmetric with ResolutionErrorKind in resolve.ts.
 * See WASM_HOST_CONTRACT.md §7 for the full mapping table.
 */
export type WasmTrapKind =
  | "unreachable" // unreachable instruction / unknown panic / default
  | "div_by_zero" // integer divide-by-zero
  | "int_overflow" // integer overflow (trunc saturation out-of-range)
  | "oob_memory" // linear-memory access out of bounds
  | "indirect_call_mismatch" // call_indirect type mismatch
  | "stack_overflow" // call stack exhausted
  | "oom"; // out of linear memory (host_alloc failure or host_panic(0x01))

/**
 * Thrown at the instantiateAndRun/host-import boundary for all WASM trap conditions.
 *
 * kind:          discriminant — use for switch/if-else at call sites
 * hostPanicCode: raw numeric code from host_panic; only set when the trap
 *                originated from a module-level host_panic call
 * message:       human-readable description including kind and optional panic message
 */
export class WasmTrap extends Error {
  readonly kind: WasmTrapKind;
  readonly hostPanicCode?: number;

  constructor(opts: { kind: WasmTrapKind; hostPanicCode?: number; message?: string }) {
    super(opts.message ?? `WasmTrap(${opts.kind})`);
    this.name = "WasmTrap";
    this.kind = opts.kind;
    // exactOptionalPropertyTypes: only assign when defined to avoid 'number|undefined' → 'number' error
    if (opts.hostPanicCode !== undefined) {
      this.hostPanicCode = opts.hostPanicCode;
    }
  }
}

/**
 * Options for createHost().
 */
export interface CreateHostOptions {
  /**
   * If provided, called for each host_log message in addition to appending
   * to the logs array. Any exception thrown by onLog is silently swallowed
   * (host_log is best-effort per WASM_HOST_CONTRACT.md §3.2).
   */
  onLog?: (msg: string) => void;
}

/**
 * The live host object returned by createHost().
 *
 * importObject: pass to WebAssembly.instantiate({importObject}) —
 *   shape: { yakcc_host: { memory, host_log, host_alloc, host_free, host_panic } }
 * memory: the shared WebAssembly.Memory (1 page, fixed)
 * logs: all messages delivered via host_log, in call order
 * close(): release the host (currently a no-op; provided for lifecycle symmetry)
 */
export interface YakccHost {
  readonly importObject: WebAssembly.Imports;
  readonly memory: WebAssembly.Memory;
  readonly logs: readonly string[];
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal: classify a WebAssembly.RuntimeError by message substring
// ---------------------------------------------------------------------------

/**
 * Map a WebAssembly.RuntimeError to a WasmTrapKind by inspecting the message.
 *
 * The message format is engine-dependent. This function handles the V8/Node.js
 * formulations. When no known substring matches, defaults to "unreachable".
 *
 * Per WASM_HOST_CONTRACT.md §7 "Engine RuntimeError classification".
 */
function classifyRuntimeError(e: WebAssembly.RuntimeError): WasmTrapKind {
  const msg = e.message.toLowerCase();
  if (msg.includes("unreachable")) return "unreachable";
  if (msg.includes("divide by zero") || msg.includes("division by zero")) return "div_by_zero";
  if (msg.includes("integer overflow")) return "int_overflow";
  if (msg.includes("memory access out of bounds") || msg.includes("out of bounds memory access"))
    return "oob_memory";
  if (msg.includes("indirect call type mismatch") || msg.includes("call_indirect"))
    return "indirect_call_mismatch";
  if (
    msg.includes("call stack exhausted") ||
    msg.includes("stack overflow") ||
    msg.includes("maximum call stack")
  )
    return "stack_overflow";
  return "unreachable"; // default per contract
}

// ---------------------------------------------------------------------------
// Internal: map host_panic code → WasmTrapKind
// ---------------------------------------------------------------------------

/**
 * Map a numeric host_panic code to WasmTrapKind.
 *
 * Per WASM_HOST_CONTRACT.md §7 trap classification table:
 *   0x01 → "oom"         (OOM panic)
 *   0x42 → "unreachable" (panic_demo — treated as unreachable)
 *   other → "unreachable" (default)
 */
function panicCodeToKind(code: number): WasmTrapKind {
  if (code === 0x01) return "oom";
  // 0x42 and all other codes map to "unreachable"
  return "unreachable";
}

// ---------------------------------------------------------------------------
// Internal: read UTF-8 string from linear memory
// ---------------------------------------------------------------------------

/**
 * Read len bytes from memory at ptr, decode as UTF-8 with replacement for
 * ill-formed sequences (U+FFFD). Returns empty string if len === 0.
 */
function readUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (len === 0) return "";
  const view = new Uint8Array(memory.buffer, ptr, len);
  // TextDecoder with fatal:false replaces ill-formed sequences (WASM_HOST_CONTRACT.md §3.2)
  return new TextDecoder("utf-8", { fatal: false }).decode(view);
}

// ---------------------------------------------------------------------------
// Public: createHost
// ---------------------------------------------------------------------------

/**
 * Create a conformant in-process host for a yakcc-compiled WASM module.
 *
 * The returned YakccHost.importObject satisfies the yakcc_host import namespace
 * required by modules emitted by compileToWasm() per WASM_HOST_CONTRACT.md §3.
 *
 * Memory model: 1 page (65536 bytes), {initial:1, maximum:1}, no growth.
 * Allocator: bump pointer starting at offset 16; host_free is a no-op.
 */
export function createHost(opts?: CreateHostOptions): YakccHost {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });

  // Bump allocator state — starts at 16 (0..15 reserved per contract §5)
  let bumpPtr = 16;

  // Mutable log array — exposed as readonly via the interface
  const logBuffer: string[] = [];

  // -------------------------------------------------------------------------
  // host_log(ptr: i32, len: i32) → void
  // -------------------------------------------------------------------------
  function hostLog(ptr: number, len: number): void {
    try {
      const msg = readUtf8(memory, ptr, len);
      logBuffer.push(msg);
      if (opts?.onLog !== undefined) {
        try {
          opts.onLog(msg);
        } catch {
          // swallow — host_log is best-effort (WASM_HOST_CONTRACT.md §3.2)
        }
      }
    } catch {
      // swallow — host_log must never throw (contract §3.2)
    }
  }

  // -------------------------------------------------------------------------
  // host_alloc(size: i32) → i32
  // -------------------------------------------------------------------------
  function hostAlloc(size: number): number {
    try {
      if (bumpPtr + size > 65536) {
        throw new WasmTrap({
          kind: "oom",
          message: `WasmTrap(oom): host_alloc(${size}) exceeds 64 KiB (bumpPtr=${bumpPtr})`,
        });
      }
      const ptr = bumpPtr;
      bumpPtr += size;
      return ptr;
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      // Re-wrap unexpected host errors per WASM_HOST_CONTRACT.md §7
      throw new WasmTrap({ kind: "unreachable", message: `WasmTrap(unreachable): ${String(e)}` });
    }
  }

  // -------------------------------------------------------------------------
  // host_free(ptr: i32) → void   — no-op in v1
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function hostFree(_ptr: number): void {
    // Deliberately a no-op per WASM_HOST_CONTRACT.md §3.4 and sub-decision 2.
    // The bump allocator cannot reclaim individual allocations; wave-3 may upgrade.
  }

  // -------------------------------------------------------------------------
  // host_panic(code: i32, ptr: i32, len: i32) → void   — always throws
  // -------------------------------------------------------------------------
  function hostPanic(code: number, ptr: number, len: number): void {
    try {
      const msg = readUtf8(memory, ptr, len);
      const kind = panicCodeToKind(code);
      const detail = msg.length > 0 ? `: ${msg}` : "";
      throw new WasmTrap({
        kind,
        hostPanicCode: code,
        message: `WasmTrap(${kind}) via host_panic(0x${code.toString(16)})${detail}`,
      });
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      // Re-wrap unexpected host errors
      throw new WasmTrap({ kind: "unreachable", message: `WasmTrap(unreachable): ${String(e)}` });
    }
  }

  // -------------------------------------------------------------------------
  // WI-V1W3-WASM-LOWER-05: String interchange host imports
  //
  // WASM_HOST_CONTRACT.md wave-3 amendment (sections 3.6-3.10).
  // All string data: (ptr: i32, len_bytes: i32) UTF-8 pairs in linear memory.
  // Host does not retain pointers after call returns.
  // Invalid UTF-8 replaced with U+FFFD (same policy as host_log).
  //
  // @decision DEC-V1-WAVE-3-WASM-LOWER-STR-001
  // @title host_string_length returns JS string.length (UTF-16 code units)
  // @status accepted
  // @rationale
  //   JavaScript .length is UTF-16 code unit count. TextDecoder gives a JS
  //   string; jsString.length is surrogate-aware, matching TS .length exactly.
  // -------------------------------------------------------------------------

  /** host_string_length(ptr: i32, len_bytes: i32) -> i32 char_count */
  function hostStringLength(ptr: number, lenBytes: number): number {
    try {
      if (lenBytes === 0) return 0;
      return readUtf8(memory, ptr, lenBytes).length;
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      throw new WasmTrap({
        kind: "unreachable",
        message: `WasmTrap(unreachable): host_string_length: ${String(e)}`,
      });
    }
  }

  /** host_string_indexof(hp: i32, hl: i32, np: i32, nl: i32) -> i32 char_index_or_-1 */
  function hostStringIndexof(hp: number, hl: number, np: number, nl: number): number {
    try {
      const haystack = readUtf8(memory, hp, hl);
      const needle = readUtf8(memory, np, nl);
      return haystack.indexOf(needle);
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      throw new WasmTrap({
        kind: "unreachable",
        message: `WasmTrap(unreachable): host_string_indexof: ${String(e)}`,
      });
    }
  }

  /**
   * host_string_slice(ptr: i32, len: i32, start: i32, end: i32, out_ptr: i32) -> void
   * Writes (new_ptr: i32 LE, new_len: i32 LE) at out_ptr and out_ptr+4.
   */
  function hostStringSlice(
    ptr: number,
    len: number,
    start: number,
    end: number,
    outPtr: number,
  ): void {
    try {
      const s = readUtf8(memory, ptr, len);
      const sliced = s.slice(start, end);
      const encoded = new TextEncoder().encode(sliced);
      const newLen = encoded.length;
      const newPtr = hostAlloc(newLen > 0 ? newLen : 1);
      if (newLen > 0) {
        new Uint8Array(memory.buffer).set(encoded, newPtr);
      }
      const dv = new DataView(memory.buffer);
      dv.setInt32(outPtr, newPtr, true);
      dv.setInt32(outPtr + 4, newLen, true);
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      throw new WasmTrap({
        kind: "unreachable",
        message: `WasmTrap(unreachable): host_string_slice: ${String(e)}`,
      });
    }
  }

  /**
   * host_string_concat(p1: i32, l1: i32, p2: i32, l2: i32, out_ptr: i32) -> void
   * Writes (new_ptr: i32 LE, new_len: i32 LE) at out_ptr and out_ptr+4.
   */
  function hostStringConcat(p1: number, l1: number, p2: number, l2: number, outPtr: number): void {
    try {
      const s1 = readUtf8(memory, p1, l1);
      const s2 = readUtf8(memory, p2, l2);
      const combined = s1 + s2;
      const encoded = new TextEncoder().encode(combined);
      const newLen = encoded.length;
      const newPtr = hostAlloc(newLen > 0 ? newLen : 1);
      if (newLen > 0) {
        new Uint8Array(memory.buffer).set(encoded, newPtr);
      }
      const dv = new DataView(memory.buffer);
      dv.setInt32(outPtr, newPtr, true);
      dv.setInt32(outPtr + 4, newLen, true);
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      throw new WasmTrap({
        kind: "unreachable",
        message: `WasmTrap(unreachable): host_string_concat: ${String(e)}`,
      });
    }
  }

  /** host_string_eq(p1: i32, l1: i32, p2: i32, l2: i32) -> i32 (1=equal, 0=not) */
  function hostStringEq(p1: number, l1: number, p2: number, l2: number): number {
    try {
      const s1 = readUtf8(memory, p1, l1);
      const s2 = readUtf8(memory, p2, l2);
      return s1 === s2 ? 1 : 0;
    } catch (e) {
      if (e instanceof WasmTrap) throw e;
      throw new WasmTrap({
        kind: "unreachable",
        message: `WasmTrap(unreachable): host_string_eq: ${String(e)}`,
      });
    }
  }

  const importObject: WebAssembly.Imports = {
    yakcc_host: {
      memory,
      host_log: hostLog,
      host_alloc: hostAlloc,
      host_free: hostFree,
      host_panic: hostPanic,
      // WI-V1W3-WASM-LOWER-05: string interchange imports (WASM_HOST_CONTRACT.md wave-3 amendment)
      host_string_length: hostStringLength,
      host_string_indexof: hostStringIndexof,
      host_string_slice: hostStringSlice,
      host_string_concat: hostStringConcat,
      host_string_eq: hostStringEq,
    },
  };

  return {
    importObject,
    memory,
    get logs(): readonly string[] {
      return logBuffer;
    },
    close(): void {
      // No-op in v1; provided for lifecycle symmetry with future resource-owning hosts.
    },
  };
}

// ---------------------------------------------------------------------------
// Public: instantiateAndRun
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: instantiate a yakcc WASM binary, call one exported
 * function, and return the numeric result plus the host object.
 *
 * Catches WebAssembly.RuntimeError and re-throws as WasmTrap with the
 * appropriate kind (classifyRuntimeError). All host-import WasmTraps propagate
 * unchanged.
 *
 * @param bytes  - Valid .wasm binary (e.g., from compileToWasm())
 * @param fnName - Name of the exported function to call (e.g., "__wasm_export_add")
 * @param args   - Arguments to pass (all treated as i32 at the WASM boundary)
 * @param opts   - Optional host configuration
 * @returns { result: number, host: YakccHost }
 * @throws WasmTrap on any trap condition
 * @throws TypeError / LinkError if the binary is invalid or imports are missing
 */
export async function instantiateAndRun(
  bytes: Uint8Array,
  fnName: string,
  args: number[],
  opts?: CreateHostOptions,
): Promise<{ result: number; host: YakccHost }> {
  const host = createHost(opts);
  try {
    // Cast through unknown: TS resolves WebAssembly.instantiate to the Module→Instance overload
    // because Uint8Array satisfies both BufferSource and Module in some lib versions.
    // The bytes overload always returns WebAssemblyInstantiatedSource at runtime.
    const { instance } = (await WebAssembly.instantiate(
      bytes,
      host.importObject,
    )) as unknown as WebAssembly.WebAssemblyInstantiatedSource;
    const fn = instance.exports[fnName];
    if (typeof fn !== "function") {
      throw new TypeError(`instantiateAndRun: export "${fnName}" is not a function`);
    }
    const result = (fn as (...a: number[]) => number)(...args);
    return { result: result as number, host };
  } catch (e) {
    if (e instanceof WasmTrap) throw e;
    if (e instanceof WebAssembly.RuntimeError) {
      throw new WasmTrap({
        kind: classifyRuntimeError(e),
        message: `WasmTrap(${classifyRuntimeError(e)}): ${e.message}`,
      });
    }
    throw e;
  }
}
