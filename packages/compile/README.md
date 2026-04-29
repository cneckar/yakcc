# @yakcc/compile

The backend interface and whole-program assembler for Yakcc.

## What this package provides

- **`Backend`** — the interface a code-emission backend must implement. A
  `Backend` receives a sequence of `Implementation` records (one per basic
  block) and emits a single source artifact. The TypeScript backend ships in
  WI-005 and is the only target in v0.
- **`assemble(registry, entryContractId, backend)`** — the whole-program
  assembler. Starting from `entryContractId`, it traverses the registry,
  collects all referenced blocks in dependency order, and delegates emission
  to the provided `Backend`. Returns an `Artifact` plus a `ProvenanceManifest`
  naming every block by content-address.
- **`Artifact`** — the emitted source text plus the file extension expected
  by the backend (e.g. `".ts"` for the TypeScript backend).
- **`ProvenanceManifest`** — an ordered list of `{ blockId, contractId }`
  entries covering every block included in the artifact. The manifest is the
  cryptographic paper trail: each `blockId` is the content-address of the
  block's source, and each `contractId` is the content-address of the spec it
  satisfies. No author identity appears in either field (DEC-NO-OWNERSHIP-011).

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
must produce the same output. The assembler may call `emit` more than once
during a single `assemble` invocation for caching purposes.

## How `assemble` works

`assemble` does NOT generate code. It composes pre-written blocks retrieved
from the registry. The sequence is:

1. Look up the entry contract in the registry.
2. Resolve its implementation and all transitive dependencies.
3. Sort blocks into dependency order (topological).
4. Call `backend.emit(blocks)` to produce the `Artifact`.
5. Build the `ProvenanceManifest` from the block and contract ids.

The assembler is pure over the registry: if the same blocks are registered,
the same artifact is produced. Registry mutations (new implementations) may
change the selected blocks, which changes the artifact and manifest.

## What this package does not do (yet)

- **No TypeScript backend** — WI-005 provides the real `TsBackend`.
- **No transitive dependency resolution** — WI-005 wires the traversal.
  v0 `assemble` returns an empty artifact.
- **No cycle detection** — WI-005 validates the dependency graph.

## License

This package is dedicated to the public domain under [The Unlicense](../../LICENSE).
