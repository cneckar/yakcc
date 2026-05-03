# WASM Host Contract — v1

**Authority:** This document is the sole boundary contract for the wasm-host surface in `@yakcc/compile`.
**Sacred Practice #12:** All tests, host runtime, and emitter must agree with this document. No parallel boundary contract, no inline contract duplicated in source beyond a one-line pointer here.

Corresponds to implementation: `packages/compile/src/wasm-host.ts`
Decision closed: `DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001`

---

## 1. Scope

This contract defines the binary interface between WASM modules emitted by `packages/compile/src/wasm-backend.ts` and the in-process host runtime provided by `packages/compile/src/wasm-host.ts`.

It covers:
- The five imports every emitted module requires from the host (`host` namespace)
- The export naming convention for emitted functions and the table placeholder
- The error model (trap mapping and structured panics)
- The string calling convention (packed i64)
- Versioning and deferred surfaces

It does **not** cover the TypeScript compilation pipeline, block resolution, or the ts-backend.

---

## 2. Identity and Types

| Symbol | TypeScript type | Notes |
|--------|----------------|-------|
| `WasmTrap` | `class extends Error` | Base class for all engine-faulted traps. |
| `WasmUnreachable` | `class extends WasmTrap` | Kind `"unreachable"`. Engine executed `unreachable` opcode. |
| `WasmDivByZero` | `class extends WasmTrap` | Kind `"div_by_zero"`. Integer divide by zero. |
| `WasmIntegerOverflow` | `class extends WasmTrap` | Kind `"integer_overflow"`. e.g. `INT32_MIN / -1`. |
| `WasmPanic` | `class extends Error` | Callee-initiated structured error via `host_panic`. Distinct from traps. |
| `WasmHost` | `interface` | The host object. Created by `createWasmHost()`. |

All are exported from `packages/compile/src/wasm-host.ts` and re-exported via `packages/compile/src/index.ts`.

---

## 3. Imports

All imports live in the module namespace `"host"`. They appear in this fixed declaration order in the import section.

| Index | Name | WAT shape | Notes |
|-------|------|-----------|-------|
| 0 | `memory` | `(import "host" "memory" (memory $mem 1 1))` | Linear memory. `initial=1, maximum=1` (64 KB). Growth is forbidden in v1 — see §6. |
| 1 | `host_log` | `(import "host" "host_log" (func (param i32 i32)))` | `(ptr: i32, len: i32) → void`. Diagnostic emission; decoded as UTF-8 and captured in `host.logs`. |
| 2 | `host_alloc` | `(import "host" "host_alloc" (func (param i32) (result i32)))` | `(size: i32) → ptr: i32`. Bump allocator; see §5. |
| 3 | `host_free` | `(import "host" "host_free" (func (param i32)))` | `(ptr: i32) → void`. Tracked no-op in v1; see §5. |
| 4 | `host_panic` | `(import "host" "host_panic" (func (param i32 i32 i32)))` | `(code: i32, ptr: i32, len: i32) → void`. Throws `WasmPanic` host-side, never returns. See §4. |

**Index discipline:** Imported function indices come before locally-defined function indices per WASM spec §2.5.5. A module with N exported functions will have funcidx 0..3 = imported host functions, funcidx 4..(4+N-1) = local functions.

**`host_panic` return type:** The WASM type is `() → void` but the host implementation throws and never returns. The emitter **must** emit `unreachable` after every `call $host_panic` to satisfy WASM stack-typing rules.

---

## 4. Exports

### Function exports

For each emitted local function `<fname>`:

```wat
(export "__wasm_export_<fname>" (func $<fname>))
```

The `__wasm_export_` prefix (double underscore) is the canonical export name format. Downstream consumers must use this form, not bare function names.

### Table export (placeholder)

```wat
(table $yakcc_table 0 0 funcref)
(export "_yakcc_table" (table $yakcc_table))
```

The table has size 0 in v1. It is reserved for indirect calls in future WIs (WI-V1W2-WASM-04+). The `exportdesc` is `0x01` (table), `tableidx=0`.

---

## 5. String Calling Convention

WASM 1.0 does not have multi-value returns without a feature flag. Functions that return strings use a **packed i64** convention:

```
return_value: i64 = (i64.extend_i32_u(out_ptr) << 32) | i64.extend_i32_u(out_len)
```

- High 32 bits: pointer into linear memory
- Low 32 bits: byte length

**Caller side:**
```ts
const packed = wrapHostCall(() => exports.__wasm_export_greet(inPtr, nameLen));
const outPtr = Number(packed >> 32n);
const outLen = Number(packed & 0xffff_ffffn);
const result = host.readUtf8(outPtr, outLen);
```

Functions that return primitives (i32, i64, f32, f64) use the natural WASM type directly — no packing.

---

## 6. Allocator

`host_alloc` uses a **bump allocator**:

- **Reserved zone:** bytes `[0, 1024)` — reserved for static/fixed scratch (currently unused; reserved for future i64 spill or guard zone).
- **Bump heap:** bytes `[1024, 65536)` — 63 KB usable.
- **Alignment:** each allocation is rounded up to 8 bytes.
- **Overflow:** if `offset + size > 65536` (cap = one WASM page), throws `WasmTrap("memory_oob", "host_alloc out of memory")`.
- **Per-instance:** each `createWasmHost()` call returns a fresh host with a fresh `WebAssembly.Memory` and a bump pointer starting at 1024. Hosts must not be shared across test cases.

`host_free` is a **tracked no-op** in v1:
- The bump allocator does not reclaim memory on `host_free`.
- The host increments an internal `_freeCallCount` counter (test-only; not part of the public contract).
- Rationale: lifetime is bounded by a single test invocation; per-test fresh `createWasmHost()` resets the bump pointer. A free-list adds zero v1 benefit.

---

## 7. Error Model

### Trap classes

Engine-level faults (`WebAssembly.RuntimeError`) are caught and rethrown as `WasmTrap` subclasses by the `wrapHostCall` helper. Mapping is concentrated in one function — no ad-hoc try/catch elsewhere.

| Engine message pattern | Rethrown class | `kind` field |
|------------------------|---------------|-------------|
| `/unreachable/i` | `WasmUnreachable` | `"unreachable"` |
| `/divide by zero/i` | `WasmDivByZero` | `"div_by_zero"` |
| `/integer overflow/i` | `WasmIntegerOverflow` | `"integer_overflow"` |
| `/out of bounds memory access/i` | `WasmTrap` | `"memory_oob"` |
| anything else | `WasmTrap` | `"other"` |

The patterns are verified against V8 (Node 20, 22, 24). The `"other"` bucket preserves the original message and `cause` so unanticipated engine messages fail loudly.

### Structured panics

`WasmPanic` is distinct from `WasmTrap`:
- A trap is a hardware-level fault surfaced by the engine (unintentional).
- A panic is a deliberate, structured signal from the compiled program via `host_panic`.

```ts
class WasmPanic extends Error {
  readonly code: number;   // panic code passed by the callee
  readonly ptr: number;    // pointer to the UTF-8 message in linear memory
  readonly len: number;    // byte length of the message
  readonly decoded: string; // UTF-8 decoded message
}
```

### `divide` substrate panic contract

The `divide(a, b)` substrate checks `b == 0` explicitly and calls `host_panic(1, ptr, len)` with a static UTF-8 message `"division by zero"` in a data segment. It does **not** rely on the engine to trap — this makes the panic path deterministic across engines and proves `host_panic` import wiring.

---

## 8. Versioning and Deferred Surfaces

### v1 constraints

- **Memory growth forbidden.** The imported memory has `maximum=1`. Any `memory.grow` instruction is a static emitter error; runtime growth attempts trap via the engine and surface as `WasmTrap("memory_oob")`.
  - Rationale: growth invalidates the `ArrayBuffer` backing the memory, forcing the host to re-cache `new Uint8Array(memory.buffer)` on every call. The v1 substrate fits in 64 KB by construction (`greet`'s name has an 8 KB hard cap).
  
- **WASM 1.0 only.** Multi-value returns (WASM 2.0 proposal) are not used; string returns use the packed i64 convention (§5).

- **Bump allocator only.** Free-list allocation is deferred to v2.

### Deferred to v2+

| Surface | Deferral reason |
|---------|----------------|
| `memory.grow` support | Buffer invalidation; not needed in 1-page v1 |
| Free-list `host_free` | Zero v1 benefit; requires metadata bookkeeping |
| Multi-value string returns | WASM 2.0 feature; not universally available |
| `_yakcc_table` population | Indirect calls not needed until WI-V1W2-WASM-04 |
| i64 arithmetic substrate | Type-lowering handled by WI-V1W2-WASM-02 |

---

## 9. Decision Log

### DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001

**Status:** Closed by WI-V1W2-WASM-03.

**Sub-decision 1 — Trap shape:** `WasmTrap` base + 3 subclasses (`WasmUnreachable`, `WasmDivByZero`, `WasmIntegerOverflow`) for engine-faulted traps; separate `WasmPanic` for callee `host_panic` calls. TypeScript `instanceof` narrowing is more ergonomic than discriminating on a `kind` field. The `kind` field is kept for JSON serialization and log emission. Mapping is concentrated in `wrapHostCall`; no ad-hoc catch elsewhere.

**Sub-decision 2 — Allocator strategy:** Bump allocator. 1024-byte reserved scratch zone, 64 KB cap (one page). `host_free` is a tracked no-op (`_freeCallCount` for test introspection). Free-list deferred to v2; `host_free` import is reserved so the contract does not change when v2 switches.

**Sub-decision 3 — Memory growth:** Forbidden in v1. Memory imported with `initial=1, maximum=1`. Growth attempts trap as `WasmTrap("memory_oob")`. Lifting this is an explicit deferred surface above.
