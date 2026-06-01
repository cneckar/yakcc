# Fixture: project-manifest

This fixture demonstrates the `.yakcc/manifest.json` format introduced by
issue #1044 (epic #1043 compose-by-reference).

## Layout

```
.yakcc/
  manifest.json   ← the project manifest (version 1, >=1 atom reference)
src/
  use-atom.ts     ← illustrative in-source reference (does not compile until #1045/#1046)
```

## Round-trip: manifest → build → typecheck → MCP tool

1. **#1044 (this issue)** — `manifest.json` is the project-level content-address
   registry. It pins the full 64-char `BlockMerkleRoot` once. In source, the model
   uses only the cheap 12-char alias prefix (`0009c5df8b58`), so each import is
   ~10 tokens instead of ~100–500 for the full implementation.

2. **#1045 (build-inline)** — `yakcc build` reads `manifest.json` and materializes
   `.yakcc/atoms/0009c5df8b58.ts` from the registry for each reference.

3. **#1046 (.d.ts stubs)** — materializes `.yakcc/atoms/0009c5df8b58.d.ts` so that
   `import { parseInt } from ".yakcc/atoms/0009c5df8b58"` typechecks before a full
   build.

4. **#1047 (yakcc_reference MCP tool)** — calls `addReference()` and returns
   `referenceImportLine(ref)` to the model, which emits the import shown in
   `src/use-atom.ts`.

## Root used in this fixture

The `root` field in `.yakcc/manifest.json` is:

```
0009c5df8b5829f90f336ae70820fedbe054415115039002cf0ec3d9b5a8caf7
```

This is a **real BlockMerkleRoot** taken from
`bootstrap/expected-roots.json` (the first entry). It corresponds to a
seed atom in the `packages/seeds` build. It was chosen because it is the
first entry in the bootstrap deterministic root list, making it stable
across rebuilds. The `symbol` field (`parseInt`) is a plausible export
name for an integer-parsing atom; it is illustrative only — the actual
export name is determined by the atom's source.
