# Reference-Emit Paid Experiment Results

*Run at: 2026-06-01T15:11:23.342Z*
*atoms: crc32c, lru-ttl-cache, avl-tree, dijkstra-heap*
*models: claude-haiku-4-5-20251001, claude-sonnet-4-6*
*reps: 2*
*total cells run: 32 / 32*

## Headline: avg output_tokens per (atom, model)

| atom | model | verbatim_out_tok | reference_out_tok | ratio | ref_behavioral_pass |
|------|-------|-----------------|------------------|-------|---------------------|
| crc32c | claude-haiku-4-5-20251001 | 514.0 | 29.0 | 17.7x | 100% |
| crc32c | claude-sonnet-4-6 | 514.0 | 28.5 | 18.0x | 100% |
| lru-ttl-cache | claude-haiku-4-5-20251001 | 1674.5 | 35.0 | 47.8x | 100% |
| lru-ttl-cache | claude-sonnet-4-6 | 1606.5 | 34.5 | 46.6x | 100% |
| avl-tree | claude-haiku-4-5-20251001 | 2717.0 | 27.0 | 100.6x | 100% |
| avl-tree | claude-sonnet-4-6 | 2697.0 | 26.5 | 101.8x | 100% |
| dijkstra-heap | claude-haiku-4-5-20251001 | 1491.5 | 25.0 | 59.7x | 100% |
| dijkstra-heap | claude-sonnet-4-6 | 2435.0 | 25.0 | 97.4x | 100% |

## Raw cell results

| atom | model | condition | rep | output_tok | input_tok | cache_read | cache_create | actual_usd | behavioral_pass |
|------|-------|-----------|-----|-----------|----------|-----------|-------------|-----------|-----------------|
| crc32c | claude-haiku-4-5-20251001 | verbatim | 0 | 514 | 605 | 0 | 6477 | $0.009017 | true |
| crc32c | claude-haiku-4-5-20251001 | verbatim | 1 | 514 | 605 | 6477 | 0 | $0.003058 | true |
| crc32c | claude-haiku-4-5-20251001 | reference | 0 | 29 | 274 | 6477 | 0 | $0.000853 | true |
| crc32c | claude-haiku-4-5-20251001 | reference | 1 | 29 | 274 | 6477 | 0 | $0.000853 | true |
| crc32c | claude-sonnet-4-6 | verbatim | 0 | 514 | 605 | 0 | 6478 | $0.033818 | true |
| crc32c | claude-sonnet-4-6 | verbatim | 1 | 514 | 3 | 6478 | 602 | $0.011920 | true |
| crc32c | claude-sonnet-4-6 | reference | 0 | 29 | 274 | 6478 | 0 | $0.003200 | true |
| crc32c | claude-sonnet-4-6 | reference | 1 | 28 | 3 | 6478 | 271 | $0.003389 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | verbatim | 0 | 1681 | 1644 | 6477 | 0 | $0.008557 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | verbatim | 1 | 1668 | 1644 | 6477 | 0 | $0.008505 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | reference | 0 | 35 | 286 | 6477 | 0 | $0.000887 | true |
| lru-ttl-cache | claude-haiku-4-5-20251001 | reference | 1 | 35 | 286 | 6477 | 0 | $0.000887 | true |
| lru-ttl-cache | claude-sonnet-4-6 | verbatim | 0 | 1611 | 1644 | 6478 | 0 | $0.031040 | true |
| lru-ttl-cache | claude-sonnet-4-6 | verbatim | 1 | 1602 | 3 | 6478 | 1641 | $0.032136 | true |
| lru-ttl-cache | claude-sonnet-4-6 | reference | 0 | 34 | 286 | 6478 | 0 | $0.003311 | true |
| lru-ttl-cache | claude-sonnet-4-6 | reference | 1 | 35 | 3 | 6478 | 283 | $0.003539 | true |
| avl-tree | claude-haiku-4-5-20251001 | verbatim | 0 | 2711 | 2785 | 6477 | 0 | $0.013590 | true |
| avl-tree | claude-haiku-4-5-20251001 | verbatim | 1 | 2723 | 2785 | 6477 | 0 | $0.013638 | true |
| avl-tree | claude-haiku-4-5-20251001 | reference | 0 | 27 | 266 | 6477 | 0 | $0.000839 | true |
| avl-tree | claude-haiku-4-5-20251001 | reference | 1 | 27 | 266 | 6477 | 0 | $0.000839 | true |
| avl-tree | claude-sonnet-4-6 | verbatim | 0 | 2697 | 2785 | 6478 | 0 | $0.050753 | true |
| avl-tree | claude-sonnet-4-6 | verbatim | 1 | 2697 | 3 | 6478 | 2782 | $0.052840 | true |
| avl-tree | claude-sonnet-4-6 | reference | 0 | 27 | 266 | 6478 | 0 | $0.003146 | true |
| avl-tree | claude-sonnet-4-6 | reference | 1 | 26 | 3 | 6478 | 263 | $0.003329 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | verbatim | 0 | 426 | 2557 | 6477 | 0 | $0.004268 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | verbatim | 1 | 2557 | 2557 | 6477 | 0 | $0.012792 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | reference | 0 | 25 | 296 | 6477 | 0 | $0.000855 | true |
| dijkstra-heap | claude-haiku-4-5-20251001 | reference | 1 | 25 | 296 | 6477 | 0 | $0.000855 | true |
| dijkstra-heap | claude-sonnet-4-6 | verbatim | 0 | 2435 | 2557 | 6478 | 0 | $0.046139 | true |
| dijkstra-heap | claude-sonnet-4-6 | verbatim | 1 | 2435 | 3 | 6478 | 2554 | $0.048055 | true |
| dijkstra-heap | claude-sonnet-4-6 | reference | 0 | 25 | 296 | 6478 | 0 | $0.003206 | true |
| dijkstra-heap | claude-sonnet-4-6 | reference | 1 | 25 | 3 | 6478 | 293 | $0.003426 | true |

## Total spend
$0.4135 across 32 cells
