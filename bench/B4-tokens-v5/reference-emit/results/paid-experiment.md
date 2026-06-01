# Reference-Emit Paid Experiment Results

*Run at: 2026-06-01T13:36:26.432Z*
*atoms: crc32c, lru-ttl-cache, avl-tree, dijkstra-heap*
*models: claude-haiku-4-5-20251001, claude-sonnet-4-6*
*reps: 2*
*total cells run: 32 / 32*

## Headline: avg output_tokens per (atom, model)

| atom | model | verbatim_out_tok | reference_out_tok | ratio | ref_behavioral_pass |
|------|-------|-----------------|------------------|-------|---------------------|
| crc32c | claude-haiku-4-5-20251001 | 624.5 | 476.0 | 1.3x | 100% |
| crc32c | claude-sonnet-4-6 | 751.0 | 552.5 | 1.4x | 100% |
| lru-ttl-cache | claude-haiku-4-5-20251001 | 1698.5 | 474.0 | 3.6x | 100% |
| lru-ttl-cache | claude-sonnet-4-6 | 1901.5 | 634.5 | 3.0x | 100% |
| avl-tree | claude-haiku-4-5-20251001 | 2867.0 | 574.0 | 5.0x | 100% |
| avl-tree | claude-sonnet-4-6 | 2712.0 | 579.0 | 4.7x | 100% |
| dijkstra-heap | claude-haiku-4-5-20251001 | 2581.5 | 430.5 | 6.0x | 100% |
| dijkstra-heap | claude-sonnet-4-6 | 2502.0 | 586.0 | 4.3x | 100% |

## Raw cell results

| atom | model | condition | rep | output_tok | input_tok | cache_read | cache_create | actual_usd | behavioral_pass |
|------|-------|-----------|-----|-----------|----------|-----------|-------------|-----------|-----------------|
| crc32c | claude-haiku-4-5-20251001 | verbatim | 0 | 591 | 605 | 0 | 5574 | $0.008422 | true |
| crc32c | claude-haiku-4-5-20251001 | verbatim | 1 | 658 | 605 | 5574 | 0 | $0.003562 | true |
| crc32c | claude-haiku-4-5-20251001 | reference | 0 | 460 | 390 | 5574 | 0 | $0.002598 | true |
| crc32c | claude-haiku-4-5-20251001 | reference | 1 | 492 | 390 | 5574 | 0 | $0.002726 | true |
| crc32c | claude-sonnet-4-6 | verbatim | 0 | 514 | 605 | 0 | 5575 | $0.030431 | true |
| crc32c | claude-sonnet-4-6 | verbatim | 1 | 988 | 3 | 5575 | 602 | $0.018759 | true |
| crc32c | claude-sonnet-4-6 | reference | 0 | 587 | 390 | 5575 | 0 | $0.011647 | true |
| crc32c | claude-sonnet-4-6 | reference | 1 | 518 | 3 | 5575 | 387 | $0.010903 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | verbatim | 0 | 1660 | 1644 | 5574 | 0 | $0.008401 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | verbatim | 1 | 1737 | 1644 | 5574 | 0 | $0.008709 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | reference | 0 | 453 | 408 | 5574 | 0 | $0.002584 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | reference | 1 | 495 | 408 | 5574 | 0 | $0.002752 | true |
| lru-ttl-cache | claude-sonnet-4-6 | verbatim | 0 | 1914 | 1644 | 5575 | 0 | $0.035314 | true |
| lru-ttl-cache | claude-sonnet-4-6 | verbatim | 1 | 1889 | 3 | 5575 | 1641 | $0.036170 | true |
| lru-ttl-cache | claude-sonnet-4-6 | reference | 0 | 618 | 408 | 5575 | 0 | $0.012167 | true |
| lru-ttl-cache | claude-sonnet-4-6 | reference | 1 | 651 | 3 | 5575 | 405 | $0.012965 | true |
| avl-tree | claude-haiku-4-5-20251001 | verbatim | 0 | 2734 | 2785 | 5574 | 0 | $0.013610 | true |
| avl-tree | claude-haiku-4-5-20251001 | verbatim | 1 | 3000 | 2785 | 5574 | 0 | $0.014674 | true |
| avl-tree | claude-haiku-4-5-20251001 | reference | 0 | 684 | 369 | 5574 | 0 | $0.003477 | true |
| avl-tree | claude-haiku-4-5-20251001 | reference | 1 | 464 | 369 | 5574 | 0 | $0.002597 | true |
| avl-tree | claude-sonnet-4-6 | verbatim | 0 | 2712 | 2785 | 5575 | 0 | $0.050708 | true |
| avl-tree | claude-sonnet-4-6 | verbatim | 1 | 2712 | 3 | 5575 | 2782 | $0.052794 | true |
| avl-tree | claude-sonnet-4-6 | reference | 0 | 591 | 369 | 5575 | 0 | $0.011645 | true |
| avl-tree | claude-sonnet-4-6 | reference | 1 | 567 | 3 | 5575 | 366 | $0.011559 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | verbatim | 0 | 2483 | 2557 | 5574 | 0 | $0.012424 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | verbatim | 1 | 2680 | 2557 | 5574 | 0 | $0.013212 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | reference | 0 | 381 | 403 | 5574 | 0 | $0.002292 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | reference | 1 | 480 | 403 | 5574 | 0 | $0.002688 | true |
| dijkstra-heap | claude-sonnet-4-6 | verbatim | 0 | 2471 | 2557 | 5575 | 0 | $0.046408 | true |
| dijkstra-heap | claude-sonnet-4-6 | verbatim | 1 | 2533 | 3 | 5575 | 2554 | $0.049254 | true |
| dijkstra-heap | claude-sonnet-4-6 | reference | 0 | 559 | 403 | 5575 | 0 | $0.011267 | true |
| dijkstra-heap | claude-sonnet-4-6 | reference | 1 | 613 | 3 | 5575 | 400 | $0.012377 | true |

## Total spend
$0.5191 across 32 cells

---

## Honest Interpretation

### The key nuance: reference-mode output is NOT just the import line

The `measure.mjs` offline analysis (#1041) measured only the import line (13–14 tokens for a
single `import { Symbol } from ".yakcc/atoms/<alias>"` line). This experiment measures what a
**real model actually writes** when placed in Section A of the discovery prompt.

The Section A instruction in the system prompt tells the model to:
1. Write the import line (`import { Symbol } from ".yakcc/atoms/<alias>"`)
2. Record the manifest entry in `.yakcc/manifest.json`
3. Write the `.d.ts` type declaration stub
4. Confirm completion with narration

So the real reference-mode output includes all four of these steps, not just step 1. The
measured avg reference output is **430–635 tokens** per (atom, model) — not the ~14-token
import-line-only figure from the offline measure. The model faithfully followed the protocol
in every single cell (behavioral_pass = 100% across all 32 cells).

### Behavioral finding: 100% compliance across all cells

Both models (Haiku 3.5, Sonnet 4.6) correctly emitted the reference path (import line present,
impl body absent) in all 16 reference cells. No model ignored the reference instruction.

### Real collapse ratio vs the idealized ~50x figure

The offline `measure.mjs` predicts ~50x collapse (verbatim impl tokens ÷ import-line-only tokens).
The real behavioral collapse — verbatim tokens ÷ **full Section A write tokens** — is:

| atom | haiku ratio | sonnet ratio | interpretation |
|------|------------|--------------|----------------|
| crc32c (small) | 1.3x | 1.4x | Small impl; reference write (narration+import+dts) costs nearly as much as writing the impl |
| lru-ttl-cache (medium) | 3.6x | 3.0x | Medium impl; reference overhead more significant |
| avl-tree (large) | 5.0x | 4.7x | Large impl; reference mode saves ~83% of output tokens |
| dijkstra-heap (large) | 6.0x | 4.3x | Large impl; best savings observed |

**Range: 1.3x–6.0x** behavioral whole-reference-write collapse across the 4 atoms measured.

### Reconciling with the 50x structural prediction

The two measurements are complementary, not contradictory:

- **Structural (offline, measure.mjs):** import-line-only measurement. For a large atom like
  `avl-tree` (~2734 verbatim tokens), the import line alone is ~13 tokens → 210x structural
  collapse. This is the *theoretical minimum* — what the system emits into the file as the
  functional artifact.

- **Behavioral (this experiment):** full model output under realistic conditions. The model also
  narrates what it did (Step 4), appends the manifest entry JSON, and writes the `.d.ts` stub
  — adding ~430–635 tokens of conversation-level overhead. This is the *actual session output
  cost* — what the API bills for.

The 50x figure from measure.mjs is the correct characterization of the **artifact collapse**
(what lands in the codebase). The 3–6x figure from this experiment is the **session output
collapse** (what the model talks into the chat). Both are real and serve different claims.

### avl-tree Haiku rep=1: hit the 3000-token verbatim cap

One cell (`avl-tree / haiku / verbatim / rep=1`) returned exactly 3000 tokens, indicating the
verbatim cap was reached. The `avl-tree` reference impl is ~2734 tokens of content; combined
with any narration the model prepends, 3000 tokens is tight. This cell's verbatim output
**may still understate** the true full write. The ratio for that atom/model (5.0x) is a
lower bound.

### Cross-reference summary

| metric | value | source |
|--------|-------|--------|
| Structural artifact collapse (import-line-only, large atoms) | ~50x–210x | measure.mjs (#1041) |
| Behavioral session-output collapse (full Section A write, large atoms) | ~4.3x–6.0x | this experiment |
| Behavioral session-output collapse (small atoms) | ~1.3x–1.4x | this experiment |
| Reference behavioral compliance rate | 100% (32/32 cells) | this experiment |
| Total spend (32 cells, 2 models, 2 reps) | $0.5191 | this experiment |
