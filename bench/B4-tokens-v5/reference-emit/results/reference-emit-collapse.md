# Reference-Emit Output-Collapse Dossier — B4-v5 Corpus

*Measured at: 2026-06-01T11:28:28.139Z*
*Token heuristic: tokens = ceil(chars / 4) — standard rough heuristic; ratio is robust to tokenizer choice*

## What This Measures

The **verbatim-write flow** (#1030) directs the model to write the full
atom implementation as its output (the `assemble()` source verbatim).
The **reference-emit flow** (#1047/#1048) directs the model to write a
single import line (~10 tokens) returned by `yakcc_reference`.

This dossier reports the **real measured OUTPUT collapse** across the 6
atoms in the B4-v5 benchmark corpus (crc32c, utf8-codec, base32-rfc4648,
lru-ttl-cache, semver-range, ring-buffer).

## Per-Atom Results

| atom | impl chars | impl tok | import chars | import tok | dts chars (1x) | dts tok (1x) | collapse |
|------|-----------|---------|-------------|-----------|---------------|-------------|---------|
| crc32c | 1233 | 309 | 51 | 13 | 272 | 68 | **23.8x** |
| utf8-codec | 3105 | 777 | 54 | 14 | 275 | 69 | **55.5x** |
| base32-rfc4648 | 2081 | 521 | 56 | 14 | 277 | 70 | **37.2x** |
| lru-ttl-cache | 4407 | 1102 | 56 | 14 | 277 | 70 | **78.7x** |
| semver-range | 3777 | 945 | 56 | 14 | 277 | 70 | **67.5x** |
| ring-buffer | 2132 | 533 | 55 | 14 | 276 | 69 | **38.1x** |

## Aggregate

| metric | value |
|--------|-------|
| corpus (6 atoms) verbatim tokens | 4187 |
| corpus (6 atoms) import tokens | 83 |
| corpus collapse ratio | **50.45x** |
| mean per-atom ratio | 50.13x |
| median per-atom ratio | 46.79x |
| min ratio (most conservative) | 23.77x |
| max ratio (most compressible) | 78.71x |

## Import Lines (reference-emit output)

- `crc32c`: `import { CRC32C } from ".yakcc/atoms/406d30eb907a";`
- `utf8-codec`: `import { Utf8Codec } from ".yakcc/atoms/ff7a1a62f8c1";`
- `base32-rfc4648`: `import { Base32Codec } from ".yakcc/atoms/8005b57d903d";`
- `lru-ttl-cache`: `import { LRUTTLCache } from ".yakcc/atoms/d1f2af8fa19c";`
- `semver-range`: `import { SemVerRange } from ".yakcc/atoms/ff40ae2d5899";`
- `ring-buffer`: `import { RingBuffer } from ".yakcc/atoms/385cf658bbd3";`

## Methodology Notes

- **Verbatim source**: `bench/B4-tokens-v5/tasks/<id>/reference-impl.ts`
  These files are the ground-truth implementations. Under the verbatim flow,
  the model writes exactly this source as its response.
- **Synthetic BlockMerkleRoot**: SHA-256 of impl source (deterministic 64-char hex).
  Used to compute the alias prefix for the import path. Not a real BLAKE3 root.
- **Token heuristic**: `tokens = ceil(chars / 4)`. Standard rough estimate.
  The ratio is robust to tokenizer choice (divisor cancels out).
- **DTS one-time cost**: `generateAtomDts(syntheticSpec, symbol)` via real
  production function. B4 atoms export classes; the synthetic spec uses empty
  inputs/outputs (→ `void`), so DTS chars are a LOWER BOUND on actual cost.
- **Reference functions**: real `@yakcc/compile` production code: `addReference`,
  `referenceImportLine`, `generateAtomDts` (same as yakcc_reference MCP tool).

## OPERATOR-GATED: Full Multi-Turn Economics

The numbers above confirm the **OUTPUT collapse** the #1041 analysis predicted.
The full cost-per-task economics also depend on inputs and narration:

- **~12.5KB discovery system prompt** amortized across all turns
- **Prompt cache efficiency**: cache_on vs cache_off (measured by v5 harness)
- **Model narration**: per-turn thinking/explanation tokens
- **Multi-turn overhead**: resolve + reference vs single compile turn

These require **paid model runs** via the v5 harness:
```
ANTHROPIC_API_KEY=... YAKCC_REGISTRY_PATH=... pnpm bench:tokens
```
**NOT measured here**: no API key is available in this environment.
The operator-gated paid run is Epic #1043 Phase 2.
