# WASM_HOST_CONTRACT.md — v1 Wave-2 WASM Host Interface Contract

> The interface specification for the in-process host runtime that mediates
> every yakcc-compiled WebAssembly module's interaction with the outside world.
> Companion to `WASM_HOST_CONTRACT.md` being a first-class structural peer to
> `FEDERATION_PROTOCOL.md` — both are load-bearing contracts that implementations
> must pass a conformance test fixture to claim compliance.
>
> **Scope:** v1 in-process host only. Shared-memory multi-threading, WASM GC,
> exception-handling proposal, and out-of-process host bridges are out of scope
> per `DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001`. This document explicitly names the
> v2/wave-3 surface for each deferred concern so the v1 implementation does not
> pre-empt those decisions.

---

## 1. Contract overview

### What this contract is

A yakcc-compiled WASM module does not run standalone. It requires a **host
runtime** — a JavaScript environment that satisfies a well-defined set of import
requirements before the module can be instantiated. This document is the
authoritative specification of that import/export boundary.

The contract governs:

- Which **imports** a WASM module compiled by yakcc requires (memory, host
  functions), their signatures, and their behavioral guarantees.
- Which **exports** a WASM module compiled by yakcc must produce (per-function
  wrappers, table placeholder).
- The **memory model** — fixed single page, no growth in v1.
- The **string/array interchange** encoding — UTF-8 length-prefix, ownership rules.
- The **error model** — how WASM traps become host-side typed exceptions, and
  how host panics propagate into the module-call boundary.
- The **diagnostic protocol** — how modules emit structured log messages.
- The **versioning** rule — how host and module announce compatibility.

### What this contract is not

- This is **not an ABI for cross-process communication.** All v1 host
  implementations run in the same JS process as the module. There is no shared
  memory, no IPC, no serialization beyond what the WASM linear memory already
  provides.
- This is **not a type-lowering specification.** The mapping from yakcc
  `SpecYak` input/output types onto WASM value types and linear-memory layouts
  belongs to WI-V1W2-WASM-02's type-lowering surface. This document specifies
  the _runtime boundary_; the type-lowering document specifies the _calling
  convention_ on top of it.
- This is **not a security boundary.** In v1, the host trusts the WASM module
  (it is compiled by yakcc itself). Sandboxing, capability isolation, and
  untrusted-module policies are v2 concerns.

### Why a contract document and not just a header

The import object that `WebAssembly.instantiate` receives is stringly typed at
the JS surface. Without a document that pins the exact shape, behavioral
semantics, and conformance requirements, every consumer reimplements a slightly
different host and diverges silently. The conformance fixture in
`wasm-host.test.ts` is the machine-enforceable projection of this document;
the document itself is the authoritative source when the fixture and the
implementation disagree.

Sacred Practice #12: there is **one** contract document, **one** reference
implementation (`wasm-host.ts`), and **one** conformance fixture
(`wasm-host.test.ts`). Any host implementation elsewhere in the repo that does
not pass the conformance fixture is non-conforming.

---

## 2. Versioning

### Host version token

Every yakcc-compiled WASM module compiled against this contract carries the
host-version token `"v1"` in its metadata. The reference host announces the
same token via:

```ts
const yakccHostVersion = "v1";
```

### Mismatch behavior

If a caller attempts to instantiate a module compiled against `"v2"` (or any
future version) using a `"v1"` host implementation, the behavior is:

- The host MUST throw a `WasmTrap { kind: "unreachable" }` before yielding the
  instantiated module.
- The host MUST NOT silently downgrade, silently upgrade, or partially satisfy
  the mismatched contract.

v1 modules carry no explicit version metadata in the binary (the WASM binary
format has no built-in module metadata slot for this). Version enforcement is
therefore a **build-time guarantee**: the `yakcc compile --target wasm` command
always emits modules that conform to the contract in effect at compile time.
Runtime version negotiation is a wave-3 surface (see §11).

---

## 3. Required imports

A module emitted by `compileToWasm` imports exactly the following symbols from
the `yakcc_host` module namespace. The host's `importObject` MUST supply all
five; supplying additional symbols under `yakcc_host` is permitted and ignored.

### 3.1 `memory` (memory import)

```
import: yakcc_host / memory
kind:   memory
limits: { initial: 1, maximum: 1 }   (pages; 1 page = 65536 bytes)
```

The host creates a `WebAssembly.Memory` instance with `{ initial: 1, maximum: 1 }`
and exposes it as an import so both the host and the WASM module share the same
linear-memory object.

**Rationale:** Importing memory (rather than exporting from the module)
lets the host pre-allocate and monitor the entire address space. The host is
then the only allocator authority; the module never calls `memory.grow`.

**Lifetime:** The host must keep the memory object alive for the entire
lifetime of the instantiated module instance. Releasing the memory while the
module is alive is undefined behavior.

**Access model:** The host reads from and writes to the memory backing buffer
via `new Uint8Array(memory.buffer)` (or subarray views). The WASM module
accesses the same buffer via normal WASM load/store instructions. Both sides
see the same bytes — there is no copy.

### 3.2 `host_log` (diagnostic emission)

```
import: yakcc_host / host_log
type:   (ptr: i32, len: i32) -> ()
```

The WASM module calls `host_log(ptr, len)` to emit a UTF-8 diagnostic message
stored at linear-memory address `[ptr, ptr + len)`.

**Preconditions (caller/module must ensure):**
- `ptr + len <= 65536` (within the single page)
- The bytes at `[ptr, ptr + len)` are valid UTF-8

**Host behavior:**
1. Read `len` bytes from the memory backing buffer starting at `ptr`.
2. Decode as UTF-8 (non-fatal: ill-formed byte sequences are replaced by the
   Unicode replacement character U+FFFD — hosts MUST NOT throw on invalid
   UTF-8 in log messages).
3. Deliver to the configured log consumer (append to `logs: string[]` in the
   reference implementation, or invoke the `onLog` callback if provided).

**Error handling:** `host_log` MUST NOT throw. If delivery fails (e.g., `onLog`
callback throws), the exception is swallowed and the module continues
executing. Diagnostic emission is best-effort.

### 3.3 `host_alloc` (bump allocator)

```
import: yakcc_host / host_alloc
type:   (size: i32) -> (ptr: i32)
```

The WASM module calls `host_alloc(size)` to request `size` bytes of linear
memory. Returns the pointer to the start of the allocated region.

**Preconditions (caller/module must ensure):**
- `size >= 0`

**Host behavior (reference implementation — bump allocator):**
1. Maintain a bump pointer `bumpPtr` initialized to `16` (offsets 0–15 are
   reserved for future use; the module MUST NOT write to 0–15 directly).
2. If `bumpPtr + size > 65536`, throw `WasmTrap { kind: "oom" }`.
3. Otherwise, record the pre-bump value as `ptr`, advance `bumpPtr += size`,
   return `ptr`.

**Contract MUST-spec:**
- `host_free` is a **valid no-op**: calling `host_free` on a pointer returned
  by `host_alloc` neither crashes nor corrupts future allocations.
- The WASM module MAY assume freed memory is **not actually reclaimed** in v1.
  This means the module must not reuse freed memory for correctness — it simply
  allocates more.
- This contract permits future production hosts to upgrade to a free-list or
  arena allocator without breaking the call-site contract, because the
  module's only guarantee is "host_free is a valid call", not "host_free
  reclaims memory immediately".

**Alignment:** The bump pointer is not guaranteed to be aligned beyond 1-byte
alignment. Callers requiring alignment beyond 1 byte must round up `size`
themselves.

**OOM:** When `host_alloc` fails, it throws `WasmTrap { kind: "oom" }`. The
module's call to `host_alloc` becomes a trap; the instantiated call does not
return normally.

### 3.4 `host_free` (no-op in v1)

```
import: yakcc_host / host_free
type:   (ptr: i32) -> ()
```

A valid no-op in v1. The host accepts any `ptr` value (including 0, invalid
pointers, and already-freed pointers) and does nothing.

**Rationale:** The bump allocator cannot reclaim individual allocations. The
no-op contract allows the module to call `host_free` at natural allocation
lifetime points so the call-site pattern survives into wave-3 when a real
allocator is introduced.

**Future:** Wave-3 memory growth removes the bump-allocator constraint. A wave-3
host MAY implement `host_free` as a real free if its allocator supports it.
The module's call sites are forward-compatible because they already call
`host_free` at the right places.

### 3.5 `host_panic` (unrecoverable error)

```
import: yakcc_host / host_panic
type:   (code: i32, ptr: i32, len: i32) -> ()
```

The WASM module calls `host_panic(code, ptr, len)` to report an unrecoverable
error condition. After the call, the module MUST execute an `unreachable`
instruction (which traps). The host call itself MUST throw — returning from
`host_panic` is undefined behavior.

**Arguments:**
- `code`: numeric error code; see §7 for the mapping to `WasmTrapKind`.
- `ptr`, `len`: optional UTF-8 message in linear memory at `[ptr, ptr + len)`.
  If `len === 0`, the message is the empty string.

**Host behavior:**
1. Read the message from memory (same as `host_log`, same UTF-8 error policy:
   replace ill-formed sequences).
2. Throw `WasmTrap { kind: codeToKind(code), hostPanicCode: code }`.

**host_panic MUST throw.** The return from `host_panic` is unreachable. Any
host that returns normally from `host_panic` is non-conforming.

---

## 4. Required exports

A module emitted by `compileToWasm` MUST export the following symbols.

### 4.1 Per-function exports: `__wasm_export_<fn>`

For each emitted function named `<fn>`, the module exports `__wasm_export_<fn>`.
The naming prefix `__wasm_export_` is the convention that distinguishes
yakcc-emitted function exports from host-visible internal symbols.

In v1 wave-2 the hard-coded substrate emits three functions:

| Export name                   | WASM signature                  |
|-------------------------------|----------------------------------|
| `__wasm_export_add`           | `(a: i32, b: i32) → i32`        |
| `__wasm_export_string_len`    | `(ptr: i32, len: i32) → i32`    |
| `__wasm_export_panic_demo`    | `() → ()`                       |

Future: WI-V1W2-WASM-02 replaces the hard-coded substrate with IR-driven
lowering. Every emitted function gets a corresponding `__wasm_export_*` export.
The naming convention does not change.

### 4.2 `_yakcc_table` (funcref placeholder)

```
export: _yakcc_table
kind:   table
type:   funcref
size:   0 (initial = 0, maximum = 0)
```

A zero-element funcref table exported as `_yakcc_table`. This export is
present in every module so host inspection code can check for the table
without the check failing on early-substrate modules. No indirect calls are
emitted in v1; the table is empty.

**Future:** WI-V1W2-WASM-03 introduces the placeholder. Indirect calls are a
wave-3 surface. The table size will grow to `N` when indirect calls are
introduced; existing code that checks `exports._yakcc_table instanceof
WebAssembly.Table` will continue to work.

---

## 5. Memory model

### Single-page fixed allocation

In v1 wave-2, the yakcc WASM runtime uses exactly **one page (65536 bytes)**
of linear memory. The memory is imported from the host (§3.1) and has:

```
{ initial: 1, maximum: 1 }
```

`memory.grow` is never called by the emitted module. Any attempt to call
`memory.grow` from within the module is a contract violation; the behavior is
undefined (the host's engine will return -1 since `maximum: 1` is already
reached, which is distinct from a trap but is also an error the module should
not be able to trigger in conforming output).

### Reserved region

Bytes `0x0000–0x000F` (offsets 0–15) are reserved. The module MUST NOT write
to this region directly. The host's bump allocator starts at offset 16.

### No growth in v1

Memory growth is explicitly **out of scope** for v1 wave-2. The `maximum: 1`
limit in the memory import enforces this at the engine level. A module that
requires more than 64 KiB of heap space MUST call `host_panic(0x01, 0, 0)` to
signal OOM; it MUST NOT call `memory.grow` and interpret `-1` as a non-fatal
condition.

**Deferred surface:** Wave-3 introduces `{initial: 1}` without `maximum`, plus
a `host_grow_callback(pages: i32) → bool` import that lets the host optionally
refuse growth. This surface will be specified in a `WASM_HOST_CONTRACT_V2.md`
or as an amendment to this document. See §11 for the explicit out-of-scope
anchor.

---

## 6. String/array interchange

### Encoding: UTF-8

All strings crossing the WASM ↔ host boundary are encoded as **UTF-8 with
explicit byte length**. There is no null terminator; the length field is the
authoritative byte count.

### Passing a string from WASM to host

1. WASM calls `host_alloc(byte_length)` to obtain a buffer pointer.
2. WASM writes the UTF-8 bytes into `[ptr, ptr + byte_length)`.
3. WASM calls the host function with `(ptr, byte_length)`.
4. WASM calls `host_free(ptr)` when done (no-op in v1 but required for
   wave-3 compatibility).

### Passing a string from host to WASM (future — not in v1 substrate)

Not exercised by the v1 hard-coded substrate. The pattern when it is
introduced (WI-V1W2-WASM-02):
1. Host calls `host_alloc(byte_length)` — wait, host cannot call WASM imports
   directly. Instead: host calls the exported `__wasm_export_alloc(size)` if
   the module exports one, or host writes directly into a pre-negotiated
   buffer region if the module exposes a buffer via export.
2. The exact convention for host→WASM string passing is deferred to
   WI-V1W2-WASM-02 and will be specified there.

### Ownership rule

The **caller allocates, the callee does not free.** When WASM passes a string
to the host (via `host_log` or as an argument to a future exported function),
the WASM module retains ownership of the buffer and is responsible for calling
`host_free` when done. The host reads the bytes during the function call and
does not hold a reference beyond the call frame.

### Array interchange (future)

Not exercised by the v1 hard-coded substrate. Arrays follow the same
length-prefix UTF-8 envelope as strings, with the element type and element
count encoded in the first few bytes of the envelope. The exact format is
deferred to WI-V1W2-WASM-02.

---

## 7. Error model

### Overview

Errors from a WASM module computation surface in two ways:

1. **WASM engine traps** — hardware-level conditions detected by the engine
   (`unreachable` instruction, divide-by-zero, memory-out-of-bounds, etc.).
   The engine throws a `WebAssembly.RuntimeError` at the WASM ↔ host
   boundary. The host re-classifies this as a typed `WasmTrap`.

2. **`host_panic` calls** — module-level explicit panics for conditions the
   module can detect but cannot recover from (OOM, invariant violations, etc.).
   The host throws `WasmTrap` from within `host_panic` before the `unreachable`
   instruction following the call can fire.

### `WasmTrap` shape

```ts
export type WasmTrapKind =
  | "unreachable"            // unreachable instruction / unknown panic
  | "div_by_zero"            // integer divide-by-zero
  | "int_overflow"           // integer overflow (i32.trunc_f64_s on out-of-range value)
  | "oob_memory"             // linear-memory access out of bounds
  | "indirect_call_mismatch" // call_indirect type mismatch
  | "stack_overflow"         // call stack exhausted
  | "oom";                   // out of linear memory (host_alloc failure)

export class WasmTrap extends Error {
  readonly kind: WasmTrapKind;
  readonly hostPanicCode?: number; // populated when thrown from host_panic
}
```

This is the **7-kind discriminated union** (decision sub-point 1 of
`DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001`). The union is exhaustive for the trap
classes reachable from v1 substrates. New trap kinds are additive-only in
future versions.

The `WasmTrap` class is **symmetric** with the `ResolutionError` class in
`packages/compile/src/resolve.ts`: both have a `readonly kind` discriminant
and a message, and neither carries recoverable state. This symmetry makes
error-handling at the pipeline level uniform.

### Trap classification table

| Condition | Source | `WasmTrapKind` |
|-----------|--------|----------------|
| `unreachable` instruction in module | Engine `RuntimeError` | `"unreachable"` |
| Integer divide by zero | Engine `RuntimeError` | `"div_by_zero"` |
| Integer overflow (trunc saturation) | Engine `RuntimeError` | `"int_overflow"` |
| Linear-memory access out of bounds | Engine `RuntimeError` | `"oob_memory"` |
| `call_indirect` type mismatch | Engine `RuntimeError` | `"indirect_call_mismatch"` |
| Call stack exhausted | Engine `RuntimeError` | `"stack_overflow"` |
| `host_alloc` OOM | Host `host_alloc` | `"oom"` |
| `host_panic(0x01, ...)` | Host `host_panic` | `"oom"` |
| `host_panic(0x42, ...)` | Host `host_panic` | `"unreachable"` |
| `host_panic(<other>, ...)` | Host `host_panic` | `"unreachable"` |

### Engine `RuntimeError` classification

The reference host (`wasm-host.ts`) classifies `WebAssembly.RuntimeError`
instances by inspecting the error message string. The message format is
engine-dependent; the reference implementation handles the V8/Node.js
formulations:

| Message substring | `WasmTrapKind` |
|-------------------|----------------|
| `"unreachable"` | `"unreachable"` |
| `"divide by zero"` | `"div_by_zero"` |
| `"integer overflow"` | `"int_overflow"` |
| `"memory access out of bounds"` | `"oob_memory"` |
| `"indirect call type mismatch"` | `"indirect_call_mismatch"` |
| `"call stack exhausted"` | `"stack_overflow"` |
| (none of the above) | `"unreachable"` (default) |

Future: standardized error codes (WebAssembly JS API post-MVP extension) would
replace this message-string heuristic. The host's classification function is
isolated (`classifyRuntimeError`) so it can be updated in one place.

### Host import error wrapping

Every host import function MUST catch non-`WasmTrap` exceptions thrown from
within the import implementation and re-throw them as
`WasmTrap { kind: "unreachable" }`. This ensures the WASM module never
observes a raw JS Error or TypeError from the host side.

---

## 8. Diagnostic emission

The `host_log(ptr, len)` import (§3.2) is the sole diagnostic channel in v1.

### Reference implementation behavior

The reference `createHost()` factory (in `wasm-host.ts`) collects all log
messages into a `logs: readonly string[]` array on the `YakccHost` object.
Callers can also supply an `onLog?: (msg: string) => void` callback in
`CreateHostOptions`; when supplied, each message is delivered to the callback
AND appended to the array.

### Diagnostic format (convention, not contract)

The module is free to format messages however it wishes. The host is format-
agnostic. Structured logging (JSON objects in the message, severity prefixes)
is a caller-level convention, not enforced here.

### Best-effort semantics

`host_log` is best-effort (§3.2). A module whose only side-effect is logging
must accept that log delivery may be silently dropped under host fault
conditions. Modules MUST NOT use `host_log` as a substitute for
`host_panic` when signaling unrecoverable conditions.

---

## 9. Conformance

Any host implementation claiming conformance with this document MUST pass the
**conformance fixture** defined in
`packages/compile/src/wasm-host.test.ts`.

### Minimum conformance test coverage

The conformance fixture covers (minimum required tests, numbered per the
fixture file):

1. `createHost()` exposes the documented `importObject` shape with all 5 keys
   under `yakcc_host`.
2. `__wasm_export_add(2, 3) === 5` via `instantiateAndRun`.
3. `__wasm_export_string_len` round-trips a UTF-8 string through `host_alloc`
   and length-passback.
4. `__wasm_export_panic_demo()` throws `WasmTrap { kind: "unreachable",
   hostPanicCode: 0x42 }`.
5. Bump allocator: 3 sequential `host_alloc(8)` calls return strictly
   increasing non-overlapping pointers.
6. OOM: `host_alloc(70000)` (> 64 KiB) throws `WasmTrap { kind: "oom" }`.
7. `_yakcc_table` is exported as a `WebAssembly.Table` with size 0.
8. Acceptance: ts-backend parity for the `add` substrate — ≥ 5 input pairs
   produce identical results from WASM + reference implementation.

### Conformance claim

A host implementation that passes all 8 tests above may claim:

> "Conformant with WASM_HOST_CONTRACT.md v1 wave-2"

---

## 10. Failure modes

| Failure | Precondition violated | Module behavior | Host behavior |
|---------|----------------------|-----------------|---------------|
| `host_alloc` OOM | `bumpPtr + size > 65536` | Receives `WasmTrap "oom"` as trap | Throws before returning |
| `host_panic` called | Module-detected invariant | Executes `unreachable` after call (engine fires the trap) | Already threw `WasmTrap` from within the call |
| Engine trap | Module instruction fault | Engine throws `RuntimeError` | `instantiateAndRun` catches and reclassifies as `WasmTrap` |
| Non-`WasmTrap` in host import | Host implementation bug | Module sees trap (import threw) | Re-thrown as `WasmTrap "unreachable"` |
| `memory` import missing | Caller did not provide `importObject` | `WebAssembly.instantiate` throws `LinkError` | Caller error; not a `WasmTrap` scenario |
| Any host import missing | Caller did not provide `importObject` | `WebAssembly.instantiate` throws `LinkError` | Caller error; not a `WasmTrap` scenario |
| Invalid UTF-8 in `host_log` | Module wrote ill-formed bytes | N/A | Host decodes with replacement (U+FFFD); does not throw |
| Invalid UTF-8 in `host_panic` message | Module wrote ill-formed bytes | N/A | Host decodes with replacement; throws `WasmTrap` as normal |
| `host_free` called with any pointer | None (no-op contract) | Continues normally | No-op; does not throw |

---

## 11. Out of scope

The following surfaces are explicitly deferred. Each item names an anchor so
future work items can reference the deferral directly.

### WASM GC (anchor: `DEFER-WASM-GC-001`)

WebAssembly GC proposal (reference types, struct types, array types). Not
needed for the primitive-and-string substrate. Wave-3 concern; requires engine
support (V8 ≥ 11.7, Bun ≥ 1.x, Node.js ≥ 22).

### Shared-memory threading (anchor: `DEFER-WASM-THREADS-001`)

`SharedArrayBuffer`-backed `WebAssembly.Memory` with `{ shared: true }`.
Requires HTTP response headers (`Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy`). Out of scope for in-process use. Wave-3 or
post-v2.

### SIMD (anchor: `DEFER-WASM-SIMD-001`)

WebAssembly SIMD proposal (`v128` value type, 128-bit vector instructions).
Not targeted by the type-lowering surface in WI-V1W2-WASM-02. Wave-3.

### Indirect calls beyond placeholder (anchor: `DEFER-WASM-INDIRECT-001`)

`call_indirect` with non-empty `_yakcc_table`. The table is exported as a
zero-element placeholder in v1. Actual indirect calls require the type-lowering
surface to emit `elem` segments. Wave-3.

### Memory64 (anchor: `DEFER-WASM-MEMORY64-001`)

64-bit linear memory address space. All v1 pointer math uses `i32`. Wave-3.

### Multi-memory (anchor: `DEFER-WASM-MULTI-MEMORY-001`)

Multiple `WebAssembly.Memory` imports. All v1 modules use exactly one memory
(§5). Wave-3.

### Exception-handling proposal (anchor: `DEFER-WASM-EH-001`)

WebAssembly exception-handling (`throw`, `catch`, `rethrow` instructions). v1
uses `unreachable` + `host_panic` for the error path; structured exceptions are
a wave-3 surface.

### Memory growth in v1 (anchor: `DEFER-WASM-MEMORY-GROWTH-001`)

`memory.grow` support and `{initial: N}` without `maximum`. Deliberately
excluded in v1 (§5). Wave-3. A future `WASM_HOST_CONTRACT_V2.md` (or amendment
to this document) will specify the `host_grow_callback` surface.

### Out-of-process host bridges (anchor: `DEFER-WASM-OOP-HOST-001`)

Serving WASM modules in separate processes (Worker, subprocess, WebAssembly
System Interface). The contract covers in-process hosts only in v1. Wave-3.

---

## 12. Acceptance for WI-V1W2-WASM-03

This section records the acceptance criteria that close the WI-V1W2-WASM-03
work item.

### Required

1. `WASM_HOST_CONTRACT.md` committed at repo root — this document.
2. `packages/compile/src/wasm-host.ts` implements `createHost()`,
   `instantiateAndRun()`, `WasmTrap`, and `YakccHost` per §§3–7.
3. `packages/compile/src/wasm-backend.ts` extended with:
   - Import section (id=2): `memory`, `host_log`, `host_alloc`, `host_free`,
     `host_panic` under `yakcc_host`.
   - Table section (id=4) and table export for `_yakcc_table`.
   - Three hard-coded exported functions: `__wasm_export_add`,
     `__wasm_export_string_len`, `__wasm_export_panic_demo`.
4. `packages/compile/src/wasm-host.test.ts` passes all 8 conformance tests
   (§9).
5. `packages/compile/src/index.ts` re-exports `createHost`,
   `instantiateAndRun`, `WasmTrap`, and their type companions.
6. `pnpm --filter @yakcc/compile test` passes (all test files).
7. `pnpm --filter @yakcc/compile typecheck` clean.
8. `pnpm -r build` clean across all packages.

---

## 13. Decision log

### DEC-V1-WAVE-2-WASM-HOST-CONTRACT-001

**Title:** WASM host interface — v1 wave-2 sub-decisions  
**Status:** accepted  
**Closed by:** WI-V1W2-WASM-03 (FuckGoblin, 2026-05-02)

This decision captures three sub-decisions that were pre-assigned to the
implementer by the planner:

---

**Sub-decision 1: Trap → host throw mapping (kind union)**

**Decision:** `WasmTrap extends Error` with discriminated `readonly kind`:
`"unreachable" | "div_by_zero" | "int_overflow" | "oob_memory" |
"indirect_call_mismatch" | "stack_overflow" | "oom"`.

**Rationale:** A 7-kind discriminated union with a single `WasmTrap` class is
symmetric with `ResolutionError` in `resolve.ts` (same pattern: typed `kind`
field, single class, discriminated switching at call sites). This symmetry
reduces the error-handling surface and makes pipeline-level error handling
uniform. A flat union (one class per kind) was considered and rejected: it
increases the import surface and makes pattern-matching unnecessarily verbose.
A single opaque `WasmError` with a numeric code was considered and rejected: it
pushes classification to every call site.

The `hostPanicCode?: number` field is additive: when the trap originates from
`host_panic`, the raw numeric code is preserved for debugging without polluting
the primary discriminant.

**Alternatives considered:** flat class hierarchy (7 subclasses) — rejected
(excessive surface, same information expressible with one class + kind field);
numeric code only — rejected (call sites need to switch on string kind for
readability).

---

**Sub-decision 2: `host_alloc` shape — bump allocator, `host_free` is no-op**

**Decision:** Reference host uses a bump allocator starting at offset 16, with
a hard cap at 65536. `host_free` is a valid no-op. The contract explicitly
states that the WASM module MAY assume freed memory is not reclaimed.

**Rationale:** A bump allocator is the simplest correct allocator for the v1
single-page fixed-size memory model. It requires exactly 1 integer of state
(`bumpPtr`) and has O(1) allocation cost. The no-op `host_free` and the "may
assume not reclaimed" rule preserve forward-compatibility: any production host
can implement a real free-list without breaking the WASM module's call-site
pattern (it already calls `host_free`; the semantic upgrade is transparent).

The alternative — a real free-list in v1 — was considered and rejected: it is
more complex than the v1 substrate requires, and a free-list over a fixed-size
single-page heap is a toy implementation anyway. Better to ship the simplest
correct thing and upgrade in wave-3.

---

**Sub-decision 3: No memory growth in v1**

**Decision:** Fixed `{initial: 1, maximum: 1}`. `memory.grow` is not called by
emitted modules and would be rejected by the engine (returns -1 against
`maximum: 1`). OOM maps to `host_panic(0x01, 0, 0)` → `WasmTrap { kind: "oom" }`.

**Rationale:** The v1 substrate (three hard-coded functions with i32 operands
and a string-length passthrough) has trivial memory requirements well within
64 KiB. Allowing growth would require the `instantiateAndRun` and `createHost`
APIs to handle memory reallocation and buffer invalidation — complexity that is
unjustified for the substrate at hand. The explicit `maximum: 1` enforces the
constraint at the engine level, not as a convention, making violation
immediately detectable during conformance testing. Wave-3 removes this
restriction under a new DEC.
