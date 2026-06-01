# Size-Stratified Token-Delta Dossier — B4-v5 Combined Corpus (#1049)

*Measured at: 2026-06-01T12:00:25.126Z*
*Token heuristic: tokens = ceil(chars / 4) — standard rough heuristic; ratio is robust to tokenizer choice*

## Overview

This dossier measures the **output-token collapse** (verbatim-write vs reference-emit)
across the combined B4-v5 corpus: 6 existing small atoms (tasks.json, issue #722)
and 3 new large/hard atoms (tasks-hard.json, issue #1049).

The headline claim from #1041 — *substitution value lives on the large/hard tail* —
is made concrete here: both absolute savings and the collapse ratio grow with atom size.

## Per-Atom Results (sorted by impl size, ascending)

| atom | stratum | impl lines | impl tokens | import tokens | savings | ratio |
|------|---------|-----------|------------|--------------|---------|-------|
| crc32c | small (existing) | 48 | 309 | 13 | 296 | **23.8x** |
| base32-rfc4648 | small (existing) | 76 | 521 | 14 | 507 | **37.2x** |
| ring-buffer | small (existing) | 79 | 533 | 14 | 519 | **38.1x** |
| utf8-codec | small (existing) | 103 | 777 | 14 | 763 | **55.5x** |
| semver-range | small (existing) | 121 | 945 | 14 | 931 | **67.5x** |
| lru-ttl-cache | small (existing) | 175 | 1102 | 14 | 1088 | **78.7x** |
| dijkstra-heap | **large (hard #1049)** | 241 | 1930 | 13 | 1917 | **148.5x** |
| pratt-expr-eval | **large (hard #1049)** | 236 | 1941 | 16 | 1925 | **121.3x** |
| avl-tree | **large (hard #1049)** | 287 | 2009 | 13 | 1996 | **154.5x** |

## Stratum Aggregates

### Small / existing v5 (6 atoms)

| metric | value |
|--------|-------|
| total verbatim tokens | 4187 |
| total import tokens | 83 |
| total savings | 4104 |
| corpus collapse ratio | **50.45x** |
| median absolute savings | 641 tok |
| median collapse ratio | 46.79x |
| min ratio | 23.77x |
| max ratio | 78.71x |

### Large / hard #1049 (3 atoms)

| metric | value |
|--------|-------|
| total verbatim tokens | 5880 |
| total import tokens | 42 |
| total savings | 5838 |
| corpus collapse ratio | **140.00x** |
| median absolute savings | 1925 tok |
| median collapse ratio | 148.46x |
| min ratio | 121.31x |
| max ratio | 154.54x |

### Combined (9 atoms)

| metric | value |
|--------|-------|
| total verbatim tokens | 10067 |
| total import tokens | 125 |
| corpus collapse ratio | **80.54x** |

## Key Finding: Savings Scale with Atom Size

The data confirms the #1041 tail-value hypothesis:

- **Median absolute savings**: small = 641 tok, large = 1925 tok (3.0× greater on the hard tail)
- **Median collapse ratio**: small = 46.8x, large = 148.5x
- **Collapse holds** for all 9 atoms: minimum ratio = 23.8x > 1.0

For the large/hard atoms (>=200 impl lines), the reference-emit flow saves
**1925+ output tokens per use** vs verbatim-write.
On a multi-turn session with repeated atom use, savings compound.

## Methodology

- **Verbatim source**: `bench/B4-tokens-v5/tasks/<id>/reference-impl.ts` (small) and
  `bench/B4-tokens-v5/tasks-hard/<id>/reference-impl.ts` (large). These are the
  ground-truth implementations the model would write under the verbatim-write flow.
- **Reference output**: one import line from real `@yakcc/compile` `referenceImportLine(addReference(...))` —
  the same production functions used by the `yakcc_reference` MCP tool (#1047).
- **Synthetic BlockMerkleRoot**: SHA-256 of impl source (deterministic 64-char hex).
- **Token heuristic**: `tokens = ceil(chars / 4)`. The ratio is robust to tokenizer choice.

## OPERATOR-GATED: Pass-Rate / Rescue-Rate Matrix

The numbers above measure **offline output collapse only**. The other half of #1049's
acceptance — unhooked fail-rate and hooked rescue-rate for the hard atoms — requires
**paid model runs** (Haiku especially) and is not done here (no API keys).

### What the paid run measures

- **Unhooked fail-rate**: how often Haiku (and Sonnet) produce a wrong implementation
  for each hard atom without the yakcc discovery hook.
- **Rescue rate**: how often the hook's auto_accept substitution rescues a failing model.
- **Token delta by size**: total turn-cost savings (input + output) for the large atoms.

### Exact command to run the matrix on the hard task set

The v5 harness `bench/B4-tokens-v5/harness/phase2-v5.mjs` hard-codes `tasks.json`
on line 282. To run it against `tasks-hard.json`, temporarily patch that reference
(or use the `--task` flag to run individual atoms by ID, e.g. `--task avl-tree`):

```bash
# One-shot per hard atom (safest — no harness modification needed):
cd bench/B4-tokens-v5
ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \
  node harness/phase2-v5.mjs --task avl-tree --n-reps 3

ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \
  node harness/phase2-v5.mjs --task pratt-expr-eval --n-reps 3

ANTHROPIC_API_KEY=<key> YAKCC_REGISTRY_PATH=<registry.db> \
  node harness/phase2-v5.mjs --task dijkstra-heap --n-reps 3
```

> **Note**: `phase2-v5.mjs --task <id>` loads the task from the hard-coded `tasks.json`.
> The three hard atoms must therefore be **added to tasks.json** before the operator
> runs the full matrix, OR the harness must be extended with a `--tasks-file` flag
> to accept an alternative manifest path such as `tasks-hard.json`.
> The `tasks-hard.json` manifest uses the same schema as `tasks.json` and is
> structurally compatible with the harness.

### Cost estimate

3 hard atoms × (cells E+F ≈ 6 cells) × 3 reps = ~54 model calls.
At Haiku-3.5 pricing and ~4 KB prompts: rough estimate ~\$0.10–\$0.30 total.
See `bench/B4-tokens-v5/harness/budget.mjs` for the per-run cap.

**NOT measured here**: no API key is available. Operator must supply ANTHROPIC_API_KEY.
