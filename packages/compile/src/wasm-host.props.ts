// SPDX-License-Identifier: MIT
// @decision DEC-V2-PROPTEST-PATH-A-001: hand-authored property-test corpus for
// @yakcc/compile wasm-host.ts atoms. Two-file pattern: this file (.props.ts) is
// vitest-free and holds the corpus; the sibling .props.test.ts is the vitest
// harness.
// Status: accepted (WI-V2-07-PREFLIGHT L3b)
// Rationale: See tmp/wi-v2-07-preflight-layer-plan.md — the corpus file must be
// runtime-independent so L10 can hash it as a manifest artifact.
//
// Atoms covered (9 named exported from wasm-host.ts):
//   WasmTrap                (WH1.1) — typed Error with kind + hostPanicCode
//   WasmTrapKind            (WH1.2) — 7-value discriminated union
//   WasiErrno               (WH1.3) — WASI preview1 errno const map
//   WasiErrnoValue          (WH1.4) — typeof WasiErrno[keyof WasiErrno]
//   CreateHostOptions       (WH1.5) — { onLog?, onExit? }
//   YakccHost               (WH1.6) — { importObject, memory, logs, close() }
//   createHost()            (WH1.7) — factory producing conformant YakccHost
//   instantiateAndRun()     (WH1.8) — async convenience wrapper (WASM required)
//
// Properties:
//   - WasmTrap is Error subclass with kind + optional hostPanicCode
//   - WasiErrno values are non-negative integers
//   - createHost() returns a YakccHost with conformant importObject shape
//   - createHost() memory is 65536 bytes (1 page, fixed)
//   - host_log messages are accumulated in .logs
//   - host_alloc advances bump pointer; OOM trap on overflow
//   - host_panic throws WasmTrap
//
// Note: instantiateAndRun() requires a valid WASM binary; properties that need
// it are deferred (documented below). All properties here use createHost() only.
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import { WasiErrno, WasmTrap, createHost } from "./wasm-host.js";
import type { WasmTrapKind } from "./wasm-host.js";

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const wasmTrapKindArb: fc.Arbitrary<WasmTrapKind> = fc.constantFrom(
  "unreachable" as WasmTrapKind,
  "div_by_zero" as WasmTrapKind,
  "int_overflow" as WasmTrapKind,
  "oob_memory" as WasmTrapKind,
  "indirect_call_mismatch" as WasmTrapKind,
  "stack_overflow" as WasmTrapKind,
  "oom" as WasmTrapKind,
);

const optionalMessageArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 1, maxLength: 80 }),
  { nil: undefined },
);

// ---------------------------------------------------------------------------
// WH1.1: WasmTrap — typed Error subclass
// ---------------------------------------------------------------------------

/**
 * prop_WasmTrap_is_Error_subclass
 *
 * WasmTrap instances are instanceof Error AND instanceof WasmTrap.
 *
 * Invariant (WH1.1): WasmTrap extends Error; try/catch blocks that catch Error
 * will also catch WasmTrap, making it safe to use as a typed guard.
 */
export const prop_WasmTrap_is_Error_subclass = fc.property(
  wasmTrapKindArb,
  optionalMessageArb,
  (kind, message) => {
    const trap = message !== undefined ? new WasmTrap({ kind, message }) : new WasmTrap({ kind });
    return trap instanceof Error && trap instanceof WasmTrap;
  },
);

/**
 * prop_WasmTrap_name_is_WasmTrap
 *
 * WasmTrap.name is always "WasmTrap".
 *
 * Invariant (WH1.1): .name is set for structured logging and error-boundary
 * pattern matching in catch blocks.
 */
export const prop_WasmTrap_name_is_WasmTrap = fc.property(wasmTrapKindArb, (kind) => {
  const trap = new WasmTrap({ kind });
  return trap.name === "WasmTrap";
});

/**
 * prop_WasmTrap_kind_preserved
 *
 * WasmTrap.kind matches the opts.kind passed to the constructor.
 *
 * Invariant (WH1.2): the kind discriminant is read-only and preserved exactly;
 * callers switch on .kind to dispatch trap handling.
 */
export const prop_WasmTrap_kind_preserved = fc.property(wasmTrapKindArb, (kind) => {
  const trap = new WasmTrap({ kind });
  return trap.kind === kind;
});

/**
 * prop_WasmTrap_default_message_contains_kind
 *
 * When no message is supplied, WasmTrap.message includes the kind string.
 *
 * Invariant (WH1.1): the default message format is "WasmTrap(<kind>)" —
 * useful for debugging without requiring callers to format the message.
 */
export const prop_WasmTrap_default_message_contains_kind = fc.property(wasmTrapKindArb, (kind) => {
  const trap = new WasmTrap({ kind });
  return trap.message.includes(kind);
});

/**
 * prop_WasmTrap_explicit_message_preserved
 *
 * When a message is supplied, WasmTrap.message matches it exactly.
 *
 * Invariant (WH1.1): the explicit message is passed to Error's constructor
 * verbatim; no truncation or transformation occurs.
 */
export const prop_WasmTrap_explicit_message_preserved = fc.property(
  wasmTrapKindArb,
  fc.string({ minLength: 1, maxLength: 80 }),
  (kind, message) => {
    const trap = new WasmTrap({ kind, message });
    return trap.message === message;
  },
);

/**
 * prop_WasmTrap_hostPanicCode_only_when_defined
 *
 * When hostPanicCode is undefined, it is not set on the WasmTrap instance.
 * When defined, it matches the provided value.
 *
 * Invariant (WH1.1, exactOptionalPropertyTypes): hostPanicCode is optional;
 * the constructor only assigns it when defined to avoid setting number|undefined
 * on the instance.
 */
export const prop_WasmTrap_hostPanicCode_only_when_defined = fc.property(
  wasmTrapKindArb,
  fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }),
  (kind, hostPanicCode) => {
    const trap =
      hostPanicCode !== undefined ? new WasmTrap({ kind, hostPanicCode }) : new WasmTrap({ kind });
    if (hostPanicCode === undefined) {
      return trap.hostPanicCode === undefined;
    }
    return trap.hostPanicCode === hostPanicCode;
  },
);

// ---------------------------------------------------------------------------
// WH1.3: WasiErrno — errno values are valid non-negative integers
// ---------------------------------------------------------------------------

/**
 * prop_WasiErrno_values_are_non_negative_integers
 *
 * Every value in the WasiErrno const map is a non-negative integer.
 *
 * Invariant (WH1.3): WASI errno values are non-negative per WASI preview1 spec.
 * They are returned from host imports to the WASM module as i32 results.
 */
export const prop_WasiErrno_values_are_non_negative_integers = fc.property(
  fc.constant(null),
  () => {
    return Object.values(WasiErrno).every(
      (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
    );
  },
);

/**
 * prop_WasiErrno_SUCCESS_is_zero
 *
 * WasiErrno.SUCCESS is 0.
 *
 * Invariant (WH1.3): WASI preview1 defines SUCCESS = 0; callers check for 0
 * to detect successful syscall returns.
 */
export const prop_WasiErrno_SUCCESS_is_zero = fc.property(fc.constant(null), () => {
  return WasiErrno.SUCCESS === 0;
});

/**
 * prop_WasiErrno_values_are_injective
 *
 * All WasiErrno values are distinct (no two keys share an integer code).
 *
 * Invariant (WH1.3): the errno map has no collisions; WASM module can
 * switch on the return value and each case corresponds to exactly one condition.
 */
export const prop_WasiErrno_values_are_injective = fc.property(fc.constant(null), () => {
  const values = Object.values(WasiErrno);
  const unique = new Set(values);
  return unique.size === values.length;
});

/**
 * prop_WasiErrno_BADF_is_8
 *
 * WasiErrno.BADF is 8 per WASI preview1.
 *
 * Invariant (WH1.3): the BADF (bad file descriptor) value is used by hostFsClose
 * and hostFsRead when the fd is not tracked in openFds.
 */
export const prop_WasiErrno_BADF_is_8 = fc.property(fc.constant(null), () => {
  return WasiErrno.BADF === 8;
});

// ---------------------------------------------------------------------------
// WH1.7: createHost() — conformant YakccHost shape
// ---------------------------------------------------------------------------

/**
 * prop_createHost_returns_importObject_with_yakcc_host
 *
 * createHost() returns a YakccHost whose importObject has a "yakcc_host" key.
 *
 * Invariant (WH1.7, WASM_HOST_CONTRACT.md §3): the import object shape is
 * { yakcc_host: { memory, host_log, host_alloc, ... } }; consumers call
 * WebAssembly.instantiate(bytes, host.importObject).
 */
export const prop_createHost_returns_importObject_with_yakcc_host = fc.property(
  fc.constant(null),
  () => {
    const host = createHost();
    const hasYakccHost = "yakcc_host" in host.importObject;
    host.close();
    return hasYakccHost;
  },
);

/**
 * prop_createHost_memory_is_one_page
 *
 * The memory returned by createHost() has exactly 65536 bytes (1 WASM page).
 *
 * Invariant (WH1.7, WASM_HOST_CONTRACT.md sub-decision 3): fixed {initial:1,
 * maximum:1}; no growth is permitted in v1.
 */
export const prop_createHost_memory_is_one_page = fc.property(fc.constant(null), () => {
  const host = createHost();
  const byteLength = host.memory.buffer.byteLength;
  host.close();
  return byteLength === 65536;
});

/**
 * prop_createHost_logs_starts_empty
 *
 * The .logs array is empty immediately after createHost().
 *
 * Invariant (WH1.6): no spurious log messages are emitted at construction time;
 * .logs only accumulates messages from host_log calls.
 */
export const prop_createHost_logs_starts_empty = fc.property(fc.constant(null), () => {
  const host = createHost();
  const isEmpty = host.logs.length === 0;
  host.close();
  return isEmpty;
});

/**
 * prop_createHost_host_alloc_returns_number_in_heap
 *
 * host_alloc(size) returns a pointer in [16, 65536) for reasonable sizes.
 *
 * Invariant (WH1.7, sub-decision 2): the bump allocator starts at offset 16
 * (0..15 reserved). Allocation of size > 0 returns ptr >= 16.
 */
export const prop_createHost_host_alloc_returns_number_in_heap = fc.property(
  fc.integer({ min: 1, max: 1024 }),
  (size) => {
    const host = createHost();
    const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = hostImports.host_alloc as (size: number) => number;
    const ptr = hostAlloc(size);
    host.close();
    return ptr >= 16 && ptr < 65536;
  },
);

/**
 * prop_createHost_host_alloc_advances_bump_ptr
 *
 * Two successive host_alloc calls return non-overlapping pointers (ptr2 >= ptr1 + size1).
 *
 * Invariant (WH1.7): the bump allocator is monotonically increasing; allocations
 * never overlap. O(1) alloc, 1 integer of state (WASM_HOST_CONTRACT.md sub-decision 2).
 */
export const prop_createHost_host_alloc_advances_bump_ptr = fc.property(
  fc.integer({ min: 1, max: 512 }),
  fc.integer({ min: 1, max: 512 }),
  (size1, size2) => {
    // Only run if combined allocation fits in 64 KiB minus the 16-byte reserved area
    fc.pre(16 + size1 + size2 <= 65536);
    const host = createHost();
    const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
    const hostAlloc = hostImports.host_alloc as (size: number) => number;
    const ptr1 = hostAlloc(size1);
    const ptr2 = hostAlloc(size2);
    host.close();
    return ptr2 >= ptr1 + size1;
  },
);

/**
 * prop_createHost_host_panic_throws_WasmTrap
 *
 * host_panic(code, ptr, len) always throws a WasmTrap.
 *
 * Invariant (WH1.7, WASM_HOST_CONTRACT.md §7): host_panic is declared [[noreturn]];
 * the host implementation always throws WasmTrap to unwind the WASM call stack.
 */
export const prop_createHost_host_panic_throws_WasmTrap = fc.property(
  fc.integer({ min: 0, max: 255 }),
  (code) => {
    const host = createHost();
    const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
    const hostPanic = hostImports.host_panic as (code: number, ptr: number, len: number) => void;
    try {
      hostPanic(code, 16, 0); // ptr=16 (valid heap start), len=0 (no message)
      host.close();
      return false; // should have thrown
    } catch (e) {
      host.close();
      return e instanceof WasmTrap;
    }
  },
);

/**
 * prop_createHost_host_panic_code_0x01_throws_oom_trap
 *
 * host_panic(0x01, ...) throws WasmTrap with kind "oom".
 *
 * Invariant (WH1.7, WASM_HOST_CONTRACT.md §7): panic code 0x01 maps to "oom"
 * per panicCodeToKind(). This is the OOM signal used by the WASM module.
 */
export const prop_createHost_host_panic_code_0x01_throws_oom_trap = fc.property(
  fc.constant(null),
  () => {
    const host = createHost();
    const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
    const hostPanic = hostImports.host_panic as (code: number, ptr: number, len: number) => void;
    try {
      hostPanic(0x01, 16, 0);
      host.close();
      return false;
    } catch (e) {
      host.close();
      return e instanceof WasmTrap && e.kind === "oom";
    }
  },
);

/**
 * prop_createHost_onLog_callback_is_called
 *
 * When onLog is provided, it is called for each host_log message.
 *
 * Invariant (WH1.5, WH1.7): the onLog option from CreateHostOptions is invoked
 * synchronously during host_log; exceptions from onLog are swallowed
 * (per WASM_HOST_CONTRACT.md §3.2 best-effort policy).
 */
export const prop_createHost_onLog_callback_is_called = fc.property(
  fc.string({ minLength: 0, maxLength: 64 }),
  (message) => {
    const received: string[] = [];
    const host = createHost({ onLog: (msg) => received.push(msg) });
    const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
    const hostLog = hostImports.host_log as (ptr: number, len: number) => void;
    const memory = host.memory;

    // Write message bytes into WASM linear memory at offset 16
    const enc = new TextEncoder().encode(message);
    new Uint8Array(memory.buffer).set(enc, 16);
    hostLog(16, enc.length);

    const ok = received.length === 1 && received[0] === message;
    host.close();
    return ok;
  },
);

/**
 * prop_createHost_logs_accumulates_messages
 *
 * host_log appends decoded messages to the .logs array in call order.
 *
 * Invariant (WH1.6, WH1.7): .logs is a mutable-behind-readonly array;
 * each host_log call appends one decoded string. Call order is preserved.
 */
export const prop_createHost_logs_accumulates_messages = fc.property(
  fc.array(fc.string({ minLength: 0, maxLength: 32 }), { minLength: 1, maxLength: 5 }),
  (messages) => {
    const host = createHost();
    const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
    const hostLog = hostImports.host_log as (ptr: number, len: number) => void;
    const memory = host.memory;
    const mem = new Uint8Array(memory.buffer);

    // Write each message at offset 16 and call host_log
    for (const msg of messages) {
      const enc = new TextEncoder().encode(msg);
      mem.set(enc, 16);
      hostLog(16, enc.length);
    }

    const ok =
      host.logs.length === messages.length && host.logs.every((log, i) => log === messages[i]);
    host.close();
    return ok;
  },
);

/**
 * prop_createHost_host_alloc_oom_throws_WasmTrap
 *
 * host_alloc with a size that exceeds the remaining heap throws WasmTrap with kind "oom".
 *
 * Invariant (WH1.7, sub-decision 3): when bumpPtr + size > 65536, hostAlloc
 * throws WasmTrap{kind:"oom"} — the module's OOM signal.
 */
export const prop_createHost_host_alloc_oom_throws_WasmTrap = fc.property(fc.constant(null), () => {
  const host = createHost();
  const hostImports = host.importObject.yakcc_host as Record<string, unknown>;
  const hostAlloc = hostImports.host_alloc as (size: number) => number;
  try {
    // Request more than the full heap (65536 bytes) to force OOM
    hostAlloc(65537);
    host.close();
    return false; // should have thrown
  } catch (e) {
    host.close();
    return e instanceof WasmTrap && e.kind === "oom";
  }
});
