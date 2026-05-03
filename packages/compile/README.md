# @yakcc/compile

The backend interface and whole-program assembler for Yakcc.

## What this package provides

- **`Backend`** — the interface a code-emission backend must implement. A
  `Backend` receives a sequence of `Implementation` records (one per basic
  block) and emits a single source artifact.
- **`tsBackend()`** — factory for the TypeScript emission backend. `yakcc compile <entry> --target ts` uses this backend.
- **`wasmBackend()`** — factory for the WASM binary emission backend (shipped WI-V1W2-WASM-01 through WI-V1W2-WASM-04). Emits a `Uint8Array` WAT-compiled binary for numeric substrates (i32/i64/f64). `compileToWasm(assembly)` is the convenience entry point.
- **`WasmTrap` / `WasmTrapKind`** — discriminated union of 7 trap kinds (unreachable, div-by-zero, integer-overflow, out-of-bounds, stack-overflow, bad-alignment, panic) mirroring `ResolutionErrorKind` symmetry. Thrown by the host runtime on WASM trap conditions.
- **`YakccHost` / `createHost()` / `instantiateAndRun()`** — the in-process WASM host runtime. `createHost()` returns a `YakccHost` implementing bump-allocator memory management and the 4 required host imports (`host_log`, `host_alloc`, `host_free`, `host_panic`). `instantiateAndRun(wasmBytes, host, fnName, args)` instantiates a WASM module against the host and invokes the named export. The host contract is documented in `WASM_HOST_CONTRACT.md` at repo root.
- **`assemble(registry, entryContractId, backend)`** — the whole-program
  assembler. Starting from `entryContractId`, it traverses the registry,
  collects all referenced blocks in dependency order (cycle detection included),
  and delegates emission to the provided `Backend`. Returns an `Artifact` plus
  a `ProvenanceManifest` naming every block by content-address.
- **`Artifact`** — the emitted source text plus the file extension expected
  by the backend (e.g. `".ts"` for the TypeScript backend).
- **`ProvenanceManifest`** — an ordered list of entries covering every block
  included in the artifact. Each entry carries:
  - `blockId` — the `blockMerkleRoot` of the block
  - `contractId` — the content-address of the spec it satisfies
  - `recursionParent` — the `blockMerkleRoot` of the parent block in the
    shave/decomposition tree, or `null` for root atoms (populated since WI-017)
  - `propertyTests` — the per-atom property test records from the proof manifest
    (populated since WI-016; never empty)

  No author identity appears in any field (DEC-NO-OWNERSHIP-011).

## The `Backend` contract

```ts
export interface Backend {
  /** File extension for emitted artifacts, including the leading dot. */
  readonly extension: string;
  /**
   * Emit a complete program artifact from an ordered list of blocks.
   * Blocks are provided in dependency order: each block's dependencies
   * appear before it in the list.
   */
  emit(blocks: readonly Implementation[]): Artifact;
}
```

Backends must be stateless and deterministic: two calls with the same input
must produce the same output.

## How `assemble` works

`assemble` does NOT generate code. It composes pre-written blocks retrieved
from the registry. The sequence is:

1. Look up the entry contract in the registry.
2. Resolve its implementation and all transitive dependencies.
3. Check the dependency graph for cycles (error thrown if a cycle is detected).
4. Sort blocks into dependency order (topological).
5. Call `backend.emit(blocks)` to produce the `Artifact`.
6. Build the `ProvenanceManifest` from block ids, contract ids, parent-block
   lineage (WI-017), and per-atom property tests (WI-016).

The assembler is pure over the registry: if the same blocks are registered,
the same artifact is produced. Registry mutations (new implementations) may
change the selected blocks, which changes the artifact and manifest.

## What is not yet wired

- **WASM string/mixed substrates** — the WASM backend covers numeric (i32/i64/f64) substrates. String-handling (linear-memory string view + `host_alloc`/`host_free`) and record/array type-lowering are deferred to a follow-on wave (WI-V1W2-WASM-02). The parity demo marks these substrates as `todo` rather than skipping silently.
- **No native binary backend** — deferred; WASM serves the portability goal without adding a native compilation dependency.

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
