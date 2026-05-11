# v2-self-shave-poc — Self-Shave Proof-of-Concept

**WI-V2-CORPUS-AND-COMPILE-SELF-EQ (GH #59)** — Slice A1 (scaffold + corpus-load helper)

This example demonstrates yakcc shaving and recompiling its own source tree — the
self-referential proof-of-concept that validates the v2 corpus pipeline. The work is
internally decomposed into three slices:

- **A1 (this slice):** Directory scaffold, corpus enumeration helper (`loadCorpusFromRegistry`),
  deterministic `corpus.manifest.json`, and a stubbed `yakcc compile-self` command (exit code 2,
  not-yet-implemented). No compile logic.
- **A2 (next):** Compile-then-test — drives `yakcc compile-self` against the corpus produced by
  A1, verifies each compiled module against its property tests.
- **A3 (after A2):** Diff harness — structural and byte-level equivalence comparison between
  the recompiled atoms and the originals recorded in `corpus.manifest.json`.

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
