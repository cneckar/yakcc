# v2-self-shave-poc — Self-Shave Proof-of-Concept

**WI-V2-CORPUS-AND-COMPILE-SELF-EQ (GH #59)** — Slices A1 + A2 landed; A3 optional stretch.

This example demonstrates yakcc shaving and recompiling its own source tree — the
self-referential proof-of-concept that validates the v2 corpus pipeline. The work is
internally decomposed into three slices:

- **A1 (landed, PR #327):** Directory scaffold, corpus enumeration helper (`loadCorpusFromRegistry`),
  deterministic `corpus.manifest.json`, and a stubbed `yakcc compile-self` command (exit code 2,
  not-yet-implemented). No compile logic.
- **A2 (landed, this slice):** Compile-then-test — drives the compile pipeline over every corpus
  atom, producing per-atom TypeScript files under `dist-recompiled/atoms/` and a manifest.json.
  Structured compose-path-gap report. See "Recompiling yakcc" section below.
- **A3 (optional stretch / future):** Diff harness — structural and byte-level equivalence
  comparison. Requires `DEC-V2-COMPILE-SELF-BYTE-EQ-001`. Blocked on workspace reconstruction
  (see A2 limitation note below).

## A2 implementation notes

**What A2 proves:**
- The compile pipeline executes over all 1889 corpus atoms without silent drops.
- Each local atom's `implSource` is compiled via `@yakcc/compile.compileToTypeScript`.
- The manifest maps every compiled file → `blockMerkleRoot` (invariant I9).
- The gap report is data-shaped (no silent drops — F1/Sacred Practice #5).
- Zero `missing-backend-feature` gaps (compileToTypeScript handles NovelGlueEntry).

**A2 architectural limitation (BLOCKED_BY_PLAN for T3(e)/(f)/(g)):**
The registry stores individual atoms (function-level), not file-level structure
(which atoms belong to which source file, in what order, with what imports).
Therefore `dist-recompiled/` is a flat collection of per-atom TS files — NOT a
reconstructed workspace that can run `pnpm -r build` or `pnpm -r test`.

The full integration proof (`pnpm -r build/test` + `bootstrap --verify` byte-identity, I10)
requires a precursor slice that adds source-file→atoms mapping to the registry, or
`WI-V2-GLUE-AWARE-IMPL (#95)` auto-routing. This is explicitly surfaced as
`BLOCKED_BY_PLAN` per `compose_path_gap_handling.implementer_routing_signal`.

## Recompiling yakcc

Run from the repo root:

```sh
# Step 1: populate the registry (skip if bootstrap/yakcc.registry.sqlite exists)
yakcc bootstrap --registry bootstrap/yakcc.registry.sqlite

# Step 2: compile all corpus atoms to dist-recompiled/
yakcc compile-self --output dist-recompiled --registry bootstrap/yakcc.registry.sqlite
```

The output directory structure:
```
dist-recompiled/
  atoms/
    <blockMerkleRoot>.ts   # one file per local corpus atom
    ...
  manifest.json            # maps atoms/<blockMerkleRoot>.ts → blockMerkleRoot
```

`dist-recompiled/` is gitignored (`DEC-V2-CORPUS-DISTRIBUTION-001`). It is reproducible
from `yakcc bootstrap` + `yakcc compile-self`.

## Compose-path-gap report

`yakcc compile-self` surfaces a structured gap report for any atoms that cannot be
compiled. Gap rows have shape:
```json
{
  "blockMerkleRoot": "<64-char hex>",
  "packageName": "<string>",
  "reason": "foreign-leaf-skipped | missing-backend-feature | unresolved-pointer | other",
  "detail": "<string>"
}
```

- `foreign-leaf-skipped`: informational — foreign atoms are not inlined (by design).
- `missing-backend-feature`: compileToTypeScript cannot handle this entry.
- `unresolved-pointer`: PointerEntry with no in-corpus resolution.
- `other`: catch-all; produces exit code 1 (unexpected failure, loud).

In A2, all 1889 corpus atoms are `local` kind with no foreign atoms, so the gap
report contains zero rows.

## Regenerating corpus.manifest.json

Run from the repo root:

```sh
yakcc bootstrap --registry bootstrap/yakcc.registry.sqlite
node -e "
  const { openRegistry } = await import('@yakcc/registry');
  const { loadCorpusFromRegistry } = await import('./examples/v2-self-shave-poc/src/load-corpus.js');
  const reg = await openRegistry('bootstrap/yakcc.registry.sqlite', {
    embeddings: { dimension: 384, modelId: 'bootstrap/null-zero', embed: async () => new Float32Array(384) }
  });
  const corpus = await loadCorpusFromRegistry(reg);
  await reg.close();
  const fs = await import('node:fs');
  const manifest = {
    _meta: {
      generatedFrom: 'yakcc bootstrap',
      generatedCommand: 'yakcc bootstrap --registry bootstrap/yakcc.registry.sqlite',
      entryCount: corpus.atoms.length,
    },
    atoms: corpus.atoms,
  };
  fs.writeFileSync('examples/v2-self-shave-poc/corpus.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log('corpus.manifest.json written:', corpus.atoms.length, 'atoms');
"
```

The manifest is committed and deterministic: the same registry always produces the same JSON.
