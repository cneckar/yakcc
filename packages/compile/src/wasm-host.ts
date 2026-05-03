// SPDX-License-Identifier: MIT
/**
 * wasm-host.ts — In-process host runtime for yakcc-compiled WebAssembly modules.
 *
 * This module implements the host side of the WASM_HOST_CONTRACT.md v1 wave-2,
 * wave-3 string, and v2 WASI-shaped syscall specifications. It provides:
 *   - createHost(): YakccHost   — construct a conformant import object + memory
 *   - instantiateAndRun(...)    — convenience wrapper: compile + run a single fn
 *   - WasmTrap                  — typed error for all trap conditions
 *   - WasmTrapKind              — discriminated union of the 7 trap classes
 *   - WasiErrno                 — WASI preview1 errno enum for v2 syscall imports
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
 * v2 syscall conformance: passes all tests in wasm-host-v2.test.ts per WASM_HOST_CONTRACT.md §14.7.
 */

import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodeProcess from "node:process";

// Validate that required Node.js modules are available at import time.
// Loud failure at instantiation per WASM_HOST_CONTRACT.md §14.1 — not deferred to first call.
// We reference the imports here to force the binding check (they are always available in Node,
// but this guards against unexpected host environments that mock or strip modules).
if (typeof nodeFs.openSync !== "function" || typeof nodeCrypto.randomFillSync !== "function") {
  throw new Error(
    "wasm-host: Node.js modules node:fs and node:crypto are required for v2 syscall imports. " +
      "Running outside Node.js is not supported.",
  );
}

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
 * WASI preview1 errno values — used by all v2 syscall host imports.
 *
 * @decision DEC-V2-WASM-HOST-CONTRACT-WASI-001
 * @title v2 syscall surface is WASI-preview1-shaped
 * @status accepted
 * @rationale
 *   Imports use `host_*` namespace — yakcc owns the namespace, not
 *   `wasi_snapshot_preview1`. The host runtime maps `host_*` to the
 *   underlying WASI/Node.js implementation. Yakcc-emitted modules MUST use
 *   `host_*` imports. Errno values follow WASI's errno enum verbatim.
 *   Ptr-and-length pairs in linear memory are consistent with wave-2/3
 *   string convention (caller ensures ptr+len <= 65536).
 */
export const WasiErrno = {
  SUCCESS: 0,
  BADF: 8,
  BADMSG: 9,
  ACCES: 13,
  EXIST: 17,
  INVAL: 20,
  ISDIR: 27,
  MFILE: 28,
  NOENT: 44,
  NOSYS: 46,
  NFILE: 63,
  PERM: 70,
  ROFS: 76,
} as const;

export type WasiErrnoValue = (typeof WasiErrno)[keyof typeof WasiErrno];

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
  /**
   * If provided, called instead of process.exit() when host_proc_exit is
   * invoked by the WASM module. Allows tests to intercept exit without
   * killing the process. The callback receives the exit code.
   */
  onExit?: (code: number) => void;
}

/**
 * The live host object returned by createHost().
 *
 * importObject: pass to WebAssembly.instantiate({importObject}) —
 *   shape: { yakcc_host: { memory, host_log, host_alloc, host_free, host_panic,
 *            host_string_*, host_fs_*, host_proc_*, host_time_*, host_random_bytes } }
 * memory: the shared WebAssembly.Memory (1 page, fixed)
 * logs: all messages delivered via host_log, in call order
 * close(): release the host (closes any open file descriptors from v2 syscalls)
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
// Internal: map Node.js syscall errors → WASI errno values
// ---------------------------------------------------------------------------

/**
 * Translate a caught Node.js syscall error (which carries an errno string code
 * like "ENOENT", "EBADF", etc.) into the corresponding WASI preview1 errno
 * integer. Unknown codes map to WasiErrno.NOSYS (46) so callers always get a
 * valid integer return rather than a JS exception escaping the host boundary.
 */
function mapNodeErrnoToWasi(e: unknown): number {
  if (e !== null && typeof e === "object" && "code" in e) {
    switch ((e as { code: string }).code) {
      case "ENOENT":
        return WasiErrno.NOENT;
      case "EACCES":
        return WasiErrno.ACCES;
      case "EPERM":
        return WasiErrno.PERM;
      case "EEXIST":
        return WasiErrno.EXIST;
      case "EISDIR":
        return WasiErrno.ISDIR;
      case "EBADF":
        return WasiErrno.BADF;
      case "EINVAL":
        return WasiErrno.INVAL;
      case "EMFILE":
        return WasiErrno.MFILE;
      case "ENFILE":
        return WasiErrno.NFILE;
      case "EROFS":
        return WasiErrno.ROFS;
      default:
        return WasiErrno.NOSYS;
    }
  }
  return WasiErrno.NOSYS;
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

  // -------------------------------------------------------------------------
  // WI-WASM-HOST-CONTRACT-V2: WASI-shaped syscall imports (WASM_HOST_CONTRACT.md §14)
  //
  // @decision DEC-V2-WASM-HOST-CONTRACT-WASI-001
  // @title v2 syscall surface is WASI-preview1-shaped
  // @status accepted
  // @rationale
  //   Imports use `host_*` namespace — yakcc owns the namespace, not
  //   `wasi_snapshot_preview1`. Node stdlib (node:fs, node:crypto, node:process,
  //   node:perf_hooks) provides the synchronous backing implementations.
  //   Synchronous APIs are used throughout to match the WASM synchronous
  //   import-call boundary (WASM imports run synchronously from the module).
  //   Errno values follow the WASI preview1 errno enum (WasiErrno const map).
  //   All non-WasmTrap host errors are caught and returned as WASI errno codes
  //   rather than propagated as JS exceptions (which would appear as traps).
  // -------------------------------------------------------------------------

  // Open file-descriptor table: tracks fds opened by host_fs_open so that
  // host_fs_close / host_fs_read / host_fs_write can validate fd ownership.
  // Node's openSync returns numeric fds; we use those directly.
  const openFds = new Set<number>();

  // ---- Filesystem ----------------------------------------------------------

  /**
   * host_fs_open(path_ptr, path_len, flags, mode_out_fd_ptr) -> errno
   * Opens a file. flags: O_RDONLY=0, O_WRONLY=1, O_RDWR=2,
   *   O_CREAT=512, O_TRUNC=1024, O_APPEND=2048.
   * Writes the opened fd (i32 LE) at mode_out_fd_ptr on SUCCESS.
   * WASI mapping: path_open (simplified flat flags → Node flags).
   */
  function hostFsOpen(
    pathPtr: number,
    pathLen: number,
    flags: number,
    modeOutFdPtr: number,
  ): number {
    try {
      const path = readUtf8(memory, pathPtr, pathLen);
      // Map combined flags integer to Node.js open flags string.
      const isWrite = (flags & 1) !== 0;
      const isRdWr = (flags & 2) !== 0;
      const isCreat = (flags & 512) !== 0;
      const isTrunc = (flags & 1024) !== 0;
      const isAppend = (flags & 2048) !== 0;
      let nodeFlags: string;
      if (isRdWr) {
        // O_RDWR flag combinations per WASM_HOST_CONTRACT.md §14.3:
        // O_TRUNC takes precedence: "w+" creates-or-truncates and opens rw from start.
        // O_CREAT without O_TRUNC: "a+" creates if missing, no truncate (append-write, read from start).
        // Neither: "r+" — file must already exist.
        if (isTrunc) {
          nodeFlags = "w+"; // O_RDWR|O_TRUNC — create-or-truncate, rw from position 0
        } else if (isCreat) {
          nodeFlags = "a+"; // O_RDWR|O_CREAT — create if missing, no truncate
        } else {
          nodeFlags = "r+"; // O_RDWR alone — file must exist
        }
      } else if (isWrite) {
        if (isAppend) nodeFlags = "a";
        else if (isTrunc) nodeFlags = "w";
        else nodeFlags = isCreat ? "w" : "r+";
      } else {
        nodeFlags = "r";
      }
      const fd = nodeFs.openSync(path, nodeFlags);
      openFds.add(fd);
      new DataView(memory.buffer).setInt32(modeOutFdPtr, fd, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_close(fd) -> errno
   * Closes a host-opened file descriptor.
   * WASI mapping: fd_close.
   */
  function hostFsClose(fd: number): number {
    if (!openFds.has(fd)) return WasiErrno.BADF;
    try {
      nodeFs.closeSync(fd);
      openFds.delete(fd);
      return WasiErrno.SUCCESS;
    } catch (e) {
      openFds.delete(fd);
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_read(fd, buf_ptr, buf_len, bytes_read_out_ptr) -> errno
   * Reads up to buf_len bytes from fd into linear memory at [buf_ptr, buf_ptr+buf_len).
   * Writes actual byte count (i32 LE) at bytes_read_out_ptr.
   * WASI mapping: fd_read (single iovec).
   */
  function hostFsRead(fd: number, bufPtr: number, bufLen: number, bytesReadOutPtr: number): number {
    if (!openFds.has(fd)) return WasiErrno.BADF;
    try {
      const buf = Buffer.alloc(bufLen);
      const bytesRead = nodeFs.readSync(fd, buf, 0, bufLen, null);
      new Uint8Array(memory.buffer).set(new Uint8Array(buf.buffer, 0, bytesRead), bufPtr);
      new DataView(memory.buffer).setInt32(bytesReadOutPtr, bytesRead, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_write(fd, buf_ptr, buf_len, bytes_written_out_ptr) -> errno
   * Writes buf_len bytes from linear memory [buf_ptr, buf_ptr+buf_len) to fd.
   * Writes actual byte count (i32 LE) at bytes_written_out_ptr.
   * WASI mapping: fd_write (single iovec).
   */
  function hostFsWrite(
    fd: number,
    bufPtr: number,
    bufLen: number,
    bytesWrittenOutPtr: number,
  ): number {
    if (!openFds.has(fd)) return WasiErrno.BADF;
    try {
      const data = Buffer.from(memory.buffer, bufPtr, bufLen);
      const written = nodeFs.writeSync(fd, data);
      new DataView(memory.buffer).setInt32(bytesWrittenOutPtr, written, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_stat(path_ptr, path_len, stat_out_ptr) -> errno
   * Stats a file. Writes 16-byte struct at stat_out_ptr:
   *   [0..8)  mtime_ns: i64 LE
   *   [8..12) size:     i32 LE
   *   [12..16) filetype: i32 LE (WASI filetype enum)
   * WASI mapping: path_filestat_get.
   */
  function hostFsStat(pathPtr: number, pathLen: number, statOutPtr: number): number {
    try {
      const path = readUtf8(memory, pathPtr, pathLen);
      const st = nodeFs.statSync(path);
      const dv = new DataView(memory.buffer);
      // mtime_ns: convert ms float to BigInt nanoseconds, write as two i32 LE halves
      const mtimeNs = BigInt(Math.floor(st.mtimeMs)) * 1_000_000n;
      const lo = Number(mtimeNs & 0xffffffffn);
      const hi = Number((mtimeNs >> 32n) & 0xffffffffn);
      dv.setUint32(statOutPtr, lo, true);
      dv.setUint32(statOutPtr + 4, hi, true);
      dv.setInt32(statOutPtr + 8, Number(st.size), true);
      // WASI filetype: 3=dir, 4=regular_file, 0=unknown
      const filetype = st.isDirectory() ? 3 : st.isFile() ? 4 : 0;
      dv.setInt32(statOutPtr + 12, filetype, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_readdir(fd, buf_ptr, buf_len, entries_out_ptr) -> errno
   * Reads directory entries from fd (must be open dir). Writes packed entries
   * into [buf_ptr, buf_ptr+buf_len). Each entry: i32 LE name_len, then UTF-8 bytes.
   * Writes entry count (i32 LE) at entries_out_ptr.
   * WASI mapping: fd_readdir (simplified).
   */
  function hostFsReaddir(
    fd: number,
    bufPtr: number,
    bufLen: number,
    entriesOutPtr: number,
  ): number {
    if (!openFds.has(fd)) return WasiErrno.BADF;
    try {
      // Get the path associated with this fd from /proc/self/fd (Linux) or fallback
      let dirPath: string;
      try {
        dirPath = nodeFs.readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        return WasiErrno.BADF;
      }
      const entries = nodeFs.readdirSync(dirPath);
      const enc = new TextEncoder();
      const dv = new DataView(memory.buffer);
      const mem = new Uint8Array(memory.buffer);
      let offset = bufPtr;
      let count = 0;
      for (const name of entries) {
        const encoded = enc.encode(name);
        const needed = 4 + encoded.length;
        if (offset + needed > bufPtr + bufLen) break;
        dv.setInt32(offset, encoded.length, true);
        offset += 4;
        mem.set(encoded, offset);
        offset += encoded.length;
        count++;
      }
      dv.setInt32(entriesOutPtr, count, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_mkdir(path_ptr, path_len, mode) -> errno
   * Creates a directory. Returns EXIST if already exists, NOENT if parent missing.
   * WASI mapping: path_create_directory.
   */
  function hostFsMkdir(pathPtr: number, pathLen: number, mode: number): number {
    try {
      const path = readUtf8(memory, pathPtr, pathLen);
      nodeFs.mkdirSync(path, { mode });
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_fs_unlink(path_ptr, path_len) -> errno
   * Unlinks a file. Returns NOENT if not found, ISDIR if path is a directory.
   * WASI mapping: path_unlink_file.
   */
  function hostFsUnlink(pathPtr: number, pathLen: number): number {
    try {
      const path = readUtf8(memory, pathPtr, pathLen);
      nodeFs.unlinkSync(path);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  // ---- Process -------------------------------------------------------------

  /**
   * host_proc_argv(buf_ptr, buf_len, bytes_written_out_ptr) -> errno
   * Writes process.argv as null-terminated UTF-8 strings.
   * WASI mapping: args_get.
   */
  function hostProcArgv(bufPtr: number, bufLen: number, bytesWrittenOutPtr: number): number {
    try {
      const enc = new TextEncoder();
      const mem = new Uint8Array(memory.buffer);
      const dv = new DataView(memory.buffer);
      let offset = bufPtr;
      let total = 0;
      for (const arg of nodeProcess.argv) {
        const encoded = enc.encode(arg);
        const needed = encoded.length + 1; // +1 for null terminator
        if (offset + needed > bufPtr + bufLen) break;
        mem.set(encoded, offset);
        offset += encoded.length;
        mem[offset] = 0; // null terminator
        offset += 1;
        total += needed;
      }
      dv.setInt32(bytesWrittenOutPtr, total, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_proc_env_get(name_ptr, name_len, buf_ptr, buf_len, bytes_written_out_ptr) -> errno
   * Looks up a single environment variable by name.
   * Returns NOENT if not set, INVAL if buf_len is too small.
   * WASI mapping: environ_get (single-variable form).
   */
  function hostProcEnvGet(
    namePtr: number,
    nameLen: number,
    bufPtr: number,
    bufLen: number,
    bytesWrittenOutPtr: number,
  ): number {
    try {
      const name = readUtf8(memory, namePtr, nameLen);
      const value = nodeProcess.env[name];
      if (value === undefined) return WasiErrno.NOENT;
      const encoded = new TextEncoder().encode(value);
      if (encoded.length > bufLen) return WasiErrno.INVAL;
      new Uint8Array(memory.buffer).set(encoded, bufPtr);
      new DataView(memory.buffer).setInt32(bytesWrittenOutPtr, encoded.length, true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_proc_exit(code) -> [[noreturn]]
   * Terminates the process. If opts.onExit is provided (e.g., in tests),
   * calls that instead of process.exit() to allow interception.
   * WASI mapping: proc_exit.
   */
  function hostProcExit(code: number): void {
    if (opts?.onExit !== undefined) {
      opts.onExit(code);
      // After onExit returns (only in test mode), throw to unwind WASM call stack.
      throw new WasmTrap({
        kind: "unreachable",
        message: `WasmTrap(unreachable): host_proc_exit(${code}) intercepted`,
      });
    }
    nodeProcess.exit(code);
  }

  // ---- Time ----------------------------------------------------------------

  /**
   * host_time_now_unix_ms(out_ptr) -> errno
   * Writes Date.now() as i64 LE (milliseconds since Unix epoch) at out_ptr.
   * WASI mapping: clock_time_get(CLOCK_REALTIME), scaled to ms.
   */
  function hostTimeNowUnixMs(outPtr: number): number {
    try {
      const nowMs = BigInt(Date.now());
      const dv = new DataView(memory.buffer);
      dv.setUint32(outPtr, Number(nowMs & 0xffffffffn), true);
      dv.setUint32(outPtr + 4, Number((nowMs >> 32n) & 0xffffffffn), true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  /**
   * host_time_monotonic_ns(out_ptr) -> errno
   * Writes monotonic clock value as i64 LE (nanoseconds) at out_ptr.
   * Uses performance.now() scaled to ns (strictly monotonic within a host instance).
   * WASI mapping: clock_time_get(CLOCK_MONOTONIC).
   */
  function hostTimeMonotonicNs(outPtr: number): number {
    try {
      // performance.now() returns float ms; scale to integer ns
      const ns = BigInt(Math.floor(performance.now() * 1_000_000));
      const dv = new DataView(memory.buffer);
      dv.setUint32(outPtr, Number(ns & 0xffffffffn), true);
      dv.setUint32(outPtr + 4, Number((ns >> 32n) & 0xffffffffn), true);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
    }
  }

  // ---- Randomness ----------------------------------------------------------

  /**
   * host_random_bytes(buf_ptr, buf_len) -> errno
   * Fills linear memory [buf_ptr, buf_ptr+buf_len) with cryptographically random bytes.
   * WASI mapping: random_get.
   */
  function hostRandomBytes(bufPtr: number, bufLen: number): number {
    try {
      const view = new Uint8Array(memory.buffer, bufPtr, bufLen);
      nodeCrypto.randomFillSync(view);
      return WasiErrno.SUCCESS;
    } catch (e) {
      return mapNodeErrnoToWasi(e);
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
      // WI-WASM-HOST-CONTRACT-V2: WASI-shaped syscall imports (WASM_HOST_CONTRACT.md §14)
      host_fs_open: hostFsOpen,
      host_fs_close: hostFsClose,
      host_fs_read: hostFsRead,
      host_fs_write: hostFsWrite,
      host_fs_stat: hostFsStat,
      host_fs_readdir: hostFsReaddir,
      host_fs_mkdir: hostFsMkdir,
      host_fs_unlink: hostFsUnlink,
      host_proc_argv: hostProcArgv,
      host_proc_env_get: hostProcEnvGet,
      host_proc_exit: hostProcExit,
      host_time_now_unix_ms: hostTimeNowUnixMs,
      host_time_monotonic_ns: hostTimeMonotonicNs,
      host_random_bytes: hostRandomBytes,
    },
  };

  return {
    importObject,
    memory,
    get logs(): readonly string[] {
      return logBuffer;
    },
    close(): void {
      // Close any file descriptors opened via host_fs_open that remain open.
      for (const fd of openFds) {
        try {
          nodeFs.closeSync(fd);
        } catch {
          // Swallow — best effort cleanup on host close.
        }
      }
      openFds.clear();
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
