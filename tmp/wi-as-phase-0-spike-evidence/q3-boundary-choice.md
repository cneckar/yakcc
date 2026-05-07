# Q3: Atom-Triplet → AS Module Boundary Choice

## Decision: Per-Atom Module (one AS file per yakcc atom)

### Chosen structural shape

Each yakcc atom maps to exactly one AssemblyScript source file and one compiled
`.wasm` output. The file is named after the atom's canonical block name.

**Evidence:** `non-ascii-rejector` atom → `q3-non-ascii-rejector-as.ts` → compiled
to `q3-non-ascii-rejector.wasm` (sha256: dc44e1bd...) → AOT to `q3-non-ascii-rejector.cwasm`
(35K native artifact). Full chain ran end-to-end with wasmtime 31.0.0.

### Why per-atom

yakcc's content-addressing is built around atomic units. Each atom has a canonical
hash derived from its `implSource`. Per-atom compilation preserves this invariant:
the WASM artifact hash directly traces back to a single implSource. Caching,
invalidation, and reproducibility all operate at the atom granularity.

Per-package or per-compilation would batch multiple atoms into one WASM module.
This makes caching coarser (any change to any atom invalidates the whole module)
and complicates the content-addressing scheme.

### Trade-offs

| concern | per-atom | per-package | per-compilation |
|---------|----------|-------------|-----------------|
| cache granularity | finest (per-implSource) | medium | coarsest |
| wasm module size | tiny (hundreds of bytes) | larger | largest |
| instantiation overhead | one per atom call | one per package | one for all |
| content-addressing fit | natural | requires remapping | requires remapping |
| isolation for testing | clean | requires filtering | requires filtering |

For the Phase 0 spike, instantiation overhead per atom is not yet measured. If
per-atom instantiation is too expensive in the hot path, a per-package bundle
(one module per seed corpus package) is the first-step mitigation. That remains
a Phase 1 question.

### End-to-end verification

```
asc q3-non-ascii-rejector-as.ts -o q3-non-ascii-rejector.wasm --optimize
wasmtime compile q3-non-ascii-rejector.wasm -o q3-non-ascii-rejector.cwasm
```

cwasm: sha256 not captured here (see q3-native-binary-exec.log).
wasm:  sha256 dc44e1bdcc10c88d94d24266c36b2efed68e50edc4e13f207c02b9072fbf441e
